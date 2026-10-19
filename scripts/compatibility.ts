import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const base = process.argv[2] ?? "http://127.0.0.1:4334/uploads";
const checksum = (body: string) =>
  createHash("sha256").update(body).digest("hex");
async function send(
  path: string,
  method = "GET",
  body?: string,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${base}${path}`, { method, body, headers });
  const value = await response.json();
  return { response, value };
}
const descriptor = {
    protocol: "salyra-upload/1",
    name: "contract.txt",
    size: 8,
    type: "text/plain",
    lastModified: 0,
    chunkSize: 4,
  },
  key = crypto.randomUUID();
const created = await send("", "POST", JSON.stringify(descriptor), {
  "Content-Type": "application/json",
  "Idempotency-Key": key,
});
assert.equal(created.response.status, 200);
const { id } = created.value;
const duplicate = await send("", "POST", JSON.stringify(descriptor), {
  "Content-Type": "application/json",
  "Idempotency-Key": key,
});
assert.equal(duplicate.value.id, id);
const conflicting = await send(
  "",
  "POST",
  JSON.stringify({ ...descriptor, size: 9 }),
  { "Content-Type": "application/json", "Idempotency-Key": key },
);
assert.equal(conflicting.response.status, 409);
const second = await send(`/${id}/parts/1`, "PUT", "efgh", {
  "Upload-Checksum": checksum("efgh"),
});
assert.equal(second.value.index, 1);
assert.equal((await send(`/${id}/complete`, "POST")).response.status, 409);
const first = await send(`/${id}/parts/0`, "PUT", "abcd", {
  "Upload-Checksum": checksum("abcd"),
});
assert.equal(first.value.sha256, checksum("abcd"));
assert.equal(
  (
    await send(`/${id}/parts/0`, "PUT", "abcd", {
      "Upload-Checksum": checksum("abcd"),
    })
  ).response.status,
  200,
);
assert.equal(
  (
    await send(`/${id}/parts/0`, "PUT", "xxxx", {
      "Upload-Checksum": checksum("xxxx"),
    })
  ).response.status,
  409,
);
const checkpoint = await send(`/${id}`);
assert.equal(checkpoint.value.parts.length, 2);
const complete = await send(`/${id}/complete`, "POST");
assert.equal(complete.response.status, 200);
assert.equal(complete.value.size, 8);
assert.deepEqual((await send(`/${id}/complete`, "POST")).value, complete.value);
assert.equal((await send(`/${id}`, "DELETE")).response.status, 409);
assert.equal((await send(`/${id}`)).value.status, "completed");
const canceled = await send("", "POST", JSON.stringify(descriptor), {
  "Content-Type": "application/json",
  "Idempotency-Key": crypto.randomUUID(),
});
assert.equal(
  (await send(`/${canceled.value.id}`, "DELETE")).response.status,
  200,
);
assert.equal(
  (
    await send(`/${canceled.value.id}/parts/0`, "PUT", "abcd", {
      "Upload-Checksum": checksum("abcd"),
    })
  ).response.status,
  409,
);
const empty = await send(
  "",
  "POST",
  JSON.stringify({ ...descriptor, size: 0 }),
  {
    "Content-Type": "application/json",
    "Idempotency-Key": crypto.randomUUID(),
  },
);
assert.equal(empty.response.status, 200);
assert.equal(
  (
    await send(`/${empty.value.id}/parts/0`, "PUT", "", {
      "Upload-Checksum": checksum(""),
    })
  ).response.status,
  200,
);
assert.equal((await send(`/${empty.value.id}/complete`, "POST")).value.size, 0);
const invalid = await send("", "POST", JSON.stringify(descriptor), {
  "Content-Type": "application/json",
  "Idempotency-Key": crypto.randomUUID(),
});
assert.equal(
  (
    await send(`/${invalid.value.id}/parts/0`, "PUT", "xxxx", {
      "Upload-Checksum": checksum("abcd"),
    })
  ).response.status,
  422,
);
assert.equal((await send(`/${invalid.value.id}`)).value.parts.length, 0);
assert.equal(
  (
    await send(`/${invalid.value.id}/parts/0`, "PUT", "abcde", {
      "Upload-Checksum": checksum("abcde"),
    })
  ).response.status,
  413,
);
assert.equal(
  (
    await send("", "POST", "{broken", {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    })
  ).response.status,
  400,
);
console.log(`HTTP contract passed: ${base}`);
