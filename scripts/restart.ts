import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const [mode, base, path, directory, container] = process.argv.slice(2);
const digest = (body: string) =>
  createHash("sha256").update(body).digest("hex");
async function request(url: string, init?: RequestInit) {
  const response = await fetch(base + url, init);
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}
if (mode === "prepare") {
  const metadata = {
    protocol: "salyra-upload/1",
    name: "restart.txt",
    size: 8,
    type: "text/plain",
    lastModified: 0,
    chunkSize: 4,
  };
  const key = randomUUID();
  const session = await request("", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(metadata),
  });
  await request(`/${session.id}/parts/0`, {
    method: "PUT",
    headers: { "Upload-Checksum": digest("abcd") },
    body: "abcd",
  });
  await writeFile(path, JSON.stringify({ key, metadata, session }));
} else if (mode === "recover") {
  const { key, metadata, session } = JSON.parse(await readFile(path, "utf8"));
  const recovered = await request("", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(metadata),
  });
  assert.equal(recovered.id, session.id);
  const checkpoint = await request(`/${session.id}`);
  assert.equal(checkpoint.parts.length, 1);
  assert.equal(checkpoint.parts[0].sha256, digest("abcd"));
  await request(`/${session.id}/parts/1`, {
    method: "PUT",
    headers: { "Upload-Checksum": digest("efgh") },
    body: "efgh",
  });
  const completed = await request(`/${session.id}/complete`, {
    method: "POST",
  });
  assert.equal(completed.size, 8);
  assert.deepEqual(
    await request(`/${session.id}/complete`, { method: "POST" }),
    completed,
  );
  console.log(`Persistent recovery passed for ${base}`);
} else if (mode === "expire") {
  // Simulate a crash after publishing the result but before committing the ledger.
  // Test fixtures share these keys, not a portable persistence format.
  const { key, metadata, session } = JSON.parse(await readFile(path, "utf8"));
  const remoteLedger = `/upload-data/sessions/${session.id}.json`;
  const ledgerPath = container
    ? path + ".ledger.json"
    : join(directory, "sessions", session.id + ".json");
  // Docker owns its private fixture files on Linux. Copy through Docker without
  // changing the server's production filesystem permissions.
  if (container)
    execFileSync("docker", ["cp", `${container}:${remoteLedger}`, ledgerPath]);
  const saveLedger = async (ledger: unknown) => {
    await writeFile(ledgerPath, JSON.stringify(ledger));
    if (container)
      execFileSync("docker", [
        "cp",
        ledgerPath,
        `${container}:${remoteLedger}`,
      ]);
  };
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.state, "completed");
  ledger.state = "finalizing";
  ledger.result = null;
  ledger.expiresAt = Date.now() - 1000;
  await saveLedger(ledger);
  const recreated = await request("", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(metadata),
  });
  assert.equal(recreated.id, session.id);
  await saveLedger(ledger);
  const recovered = await request(`/${session.id}`);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.result.size, 8);
  const canceled = await fetch(base + `/${session.id}`, { method: "DELETE" });
  assert.equal(canceled.status, 409);
  assert.equal((await canceled.json()).code, "COMPLETED");
  if (container) await rm(ledgerPath, { force: true });
  console.log(`Expired finalization recovery passed for ${base}`);
} else
  throw new Error(
    "Use prepare/recover/expire, the base URL and the fixture path",
  );
