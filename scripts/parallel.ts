// Chunks of one upload arrive side by side. Run against a native example server:
//   node --import tsx scripts/parallel.ts <base url> [container]
// Without a container the assertions that read the server's files are skipped.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://127.0.0.1:4334/uploads";
const container = process.argv[3];
// php -S reads a request body whole before it runs the script, so a half-sent chunk never
// reaches the engine there. The assertions that need a chunk to stall inside it are skipped.
const buffered = process.env.SALYRA_BUFFERED_BODIES === "1";
const digest = (body: string) =>
  createHash("sha256").update(body).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(path: string, method = "GET", body?: string) {
  const response = await fetch(`${base}${path}`, {
    method,
    body,
    headers: body ? { "Upload-Checksum": digest(body) } : {},
  });
  return { status: response.status, value: await response.json() };
}
async function create(chunks: number) {
  const response = await fetch(base, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({
      protocol: "salyra-upload/1",
      name: "parallel.txt",
      size: chunks * 4,
      type: "text/plain",
      lastModified: 0,
      chunkSize: 4,
    }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as { id: string; expiresAt: number };
}
/**
 * A chunk whose body is sent in two halves: the server is inside the part operation, waiting
 * for the rest, until finish() is called. Content-Length framing works with every example
 * server; the C and Python ones do not read chunked bodies.
 */
function stalled(id: string, index: number, body: string) {
  const request = httpRequest(`${base}/${id}/parts/${index}`, {
    method: "PUT",
    agent: false,
    headers: {
      "Content-Length": String(Buffer.byteLength(body)),
      "Upload-Checksum": digest(body),
    },
  });
  const done = new Promise<{ status: number; value: any }>(
    (resolve, reject) => {
      request.on("error", reject);
      request.on("response", (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part) => parts.push(part));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            value: JSON.parse(Buffer.concat(parts).toString("utf8") || "null"),
          }),
        );
      });
    },
  );
  request.write(body.slice(0, 2));
  return { done, finish: () => request.end(body.slice(2)) };
}
async function within<T>(promise: Promise<T>, ms: number, what: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not finish within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function pendingFor(promise: Promise<unknown>, ms: number) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await sleep(ms);
  return !settled;
}
function inContainer(script: string) {
  return execFileSync("docker", ["exec", container!, "sh", "-c", script], {
    encoding: "utf8",
  });
}
const text = (index: number) => String(1000 + index);

// 1. A chunk that is still streaming blocks no other chunk of the same upload.
{
  const { id } = await create(4);
  const slow = stalled(id, 0, "abcd");
  await sleep(500);
  const others = await within(
    Promise.all(
      [1, 2, 3].map((i) => send(`/${id}/parts/${i}`, "PUT", text(i))),
    ),
    8000,
    "chunks 1-3 while chunk 0 streams",
  );
  for (const [i, other] of others.entries()) {
    assert.equal(other.status, 200, JSON.stringify(other.value));
    assert.equal(other.value.index, i + 1);
  }
  const during = await send(`/${id}`);
  assert.deepEqual(
    during.value.parts.map((part: { index: number }) => part.index),
    [1, 2, 3],
  );
  slow.finish();
  const first = await within(slow.done, 8000, "chunk 0");
  assert.equal(first.status, 200, JSON.stringify(first.value));
  assert.equal(first.value.sha256, digest("abcd"));
  const completed = await send(`/${id}/complete`, "POST");
  assert.equal(completed.status, 200, JSON.stringify(completed.value));
  assert.equal(
    completed.value.sha256,
    digest("abcd" + [1, 2, 3].map(text).join("")),
  );
}

// 2. One writer per chunk number: the same chunk sent twice at once is stored once.
{
  const { id } = await create(2);
  const slow = stalled(id, 0, "abcd");
  await sleep(500);
  const twin = send(`/${id}/parts/0`, "PUT", "abcd");
  if (!buffered)
    assert.ok(
      await pendingFor(twin, 800),
      "a second request for a chunk that is streaming should wait for it",
    );
  slow.finish();
  const [first, second] = await within(
    Promise.all([slow.done, twin]),
    8000,
    "both requests for chunk 0",
  );
  assert.equal(first.status, 200, JSON.stringify(first.value));
  assert.equal(second.status, 200, JSON.stringify(second.value));
  assert.equal(second.value.sha256, digest("abcd"));
  const after = await send(`/${id}`);
  assert.deepEqual(
    after.value.parts.map((part: { index: number }) => part.index),
    [0],
  );
  if (buffered)
    assert.equal((await send(`/${id}/parts/1`, "PUT", "efgh")).status, 200);
  else {
    // a different body for a chunk that waited is a conflict, not a second copy
    const rival = stalled(id, 1, "efgh");
    await sleep(500);
    const wrong = send(`/${id}/parts/1`, "PUT", "zzzz");
    assert.ok(await pendingFor(wrong, 800));
    rival.finish();
    await within(rival.done, 8000, "chunk 1");
    const conflict = await within(wrong, 8000, "the conflicting chunk 1");
    assert.equal(conflict.status, 409, JSON.stringify(conflict.value));
    assert.equal(conflict.value.code, "PART_CONFLICT");
  }
  const completed = await send(`/${id}/complete`, "POST");
  assert.equal(completed.value.sha256, digest("abcdefgh"));
}

// 3. A session canceled while a chunk streams does not take the chunk.
{
  const { id } = await create(2);
  const slow = stalled(id, 0, "abcd");
  await sleep(500);
  assert.equal((await send(`/${id}`, "DELETE")).status, 200);
  slow.finish();
  const late = await within(slow.done, 8000, "the chunk of a canceled upload");
  assert.notEqual(late.status, 200, "a canceled upload accepted a chunk");
  const state = await send(`/${id}`);
  assert.equal(state.value.status, "canceled");
  assert.deepEqual(state.value.parts, []);
}

// 4. Many chunks at once: none is lost from the session record, and the TTL follows progress.
{
  const chunks = 24;
  const created = await create(chunks);
  const { id } = created;
  const results = await within(
    Promise.all(
      Array.from({ length: chunks }, (_, i) =>
        send(`/${id}/parts/${i}`, "PUT", text(i)),
      ),
    ),
    30000,
    `${chunks} chunks at once`,
  );
  for (const result of results)
    assert.equal(result.status, 200, JSON.stringify(result.value));
  if (container) {
    // read before any probe: a probe rebuilds the record from storage and would hide a lost update
    const record = JSON.parse(
      inContainer(`cat /upload-data/sessions/${id}.json`),
    );
    assert.deepEqual(
      record.parts.map((part: { index: number }) => part.index),
      Array.from({ length: chunks }, (_, i) => i),
      "the session record lost a chunk",
    );
  }
  const probe = await send(`/${id}`);
  assert.equal(probe.value.parts.length, chunks);
  assert.ok(
    probe.value.expiresAt > created.expiresAt,
    "a stored chunk should extend the session's expiry",
  );
  const completed = await send(`/${id}/complete`, "POST");
  assert.equal(completed.status, 200, JSON.stringify(completed.value));
  assert.equal(
    completed.value.sha256,
    digest(Array.from({ length: chunks }, (_, i) => text(i)).join("")),
  );
  if (container) {
    const left = inContainer(
      `find /upload-data -name '${id}-part-*' 2>/dev/null | wc -l`,
    ).trim();
    assert.equal(
      left,
      "0",
      "chunk locks of a finished upload should be removed",
    );
  }
}
console.log(`Parallel chunks passed: ${base}`);
