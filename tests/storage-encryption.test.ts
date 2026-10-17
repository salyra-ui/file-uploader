import { afterEach, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  copyFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  encryptedFilesystemStorage,
  type EncryptionKeyring,
} from "../packages/upload-server/src/storage/encryption";
import { filesystemSessionStore } from "../packages/upload-server/src/storage/filesystem";
import {
  createUploadServer,
  type ServerSession,
} from "../packages/upload-server/src";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture(bytes = randomBytes(150000), chunkSize = 100000) {
  const directory = await mkdtemp(join(tmpdir(), "salyra-encryption-"));
  dirs.push(directory);
  const keys = new Map([
    ["v1", randomBytes(32)],
    ["v2", randomBytes(32)],
  ]);
  let active = "v1";
  const ring: EncryptionKeyring = {
    current: () => ({ id: active, key: keys.get(active)! }),
    resolve: (id) => keys.get(id),
  };
  const storage = encryptedFilesystemStorage({
    directory: join(directory, "content"),
    keys: ring,
  });
  const ledger = filesystemSessionStore(join(directory, "sessions"));
  const engine = createUploadServer({ allowAnonymous: true, storage, sessionStore: ledger });
  const descriptor = {
    protocol: "salyra-upload/1" as const,
    name: "private.txt",
    size: bytes.length,
    type: "text/plain",
    lastModified: 0,
    chunkSize,
  };
  const created = await engine.createUpload(descriptor, "original");
  const send = async (index: number) => {
    const part = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
    return engine.receivePart(
      created.id,
      index,
      digest(part),
      Readable.from([part]),
    );
  };
  const parts = Math.max(1, Math.ceil(bytes.length / chunkSize));
  const upload = async () => {
    for (let index = parts - 1; index >= 0; index--) await send(index);
    return engine.finishUpload(created.id);
  };
  const collect = async () => {
    const values: Buffer[] = [];
    for await (const value of await storage.read(created.id))
      values.push(value);
    return Buffer.concat(values);
  };
  return {
    directory,
    storage,
    ledger,
    engine,
    descriptor,
    created,
    send,
    upload,
    collect,
    keys,
    ring,
    rotate: () => {
      active = "v2";
    },
    bytes,
  };
}
it("streams out-of-order chunks, preserves plaintext receipts and decrypts the completed upload", async () => {
  const f = await fixture();
  await f.upload();
  expect(await f.collect()).toEqual(f.bytes);
  const session = (await f.ledger.get(f.created.id))!;
  expect(session.result).toMatchObject({
    size: f.bytes.length,
    sha256: digest(f.bytes),
    encryption: { keyId: "v1" },
  });
  const folder = join(f.directory, "content", "files", f.created.id);
  const encoded = await readFile(join(folder, "0.enc"));
  expect(encoded.includes(f.bytes.subarray(0, 64))).toBe(false);
  expect((await stat(join(folder, "0.enc"))).mode & 0o777).toBe(0o600);
  expect(
    (await readFile(join(folder, "reference.json"))).includes(
      f.keys.get("v1")!,
    ),
  ).toBe(false);
  expect(await f.storage.inspectResult(session, undefined)).toMatchObject({
    found: true,
  });
  await f.storage.remove!(session.result, undefined);
  expect(await f.storage.inspectResult(session, undefined)).toEqual({
    found: false,
  });
});
it("pins a session key across process restart and key rotation", async () => {
  const f = await fixture();
  await f.send(0);
  f.rotate();
  const restarted = encryptedFilesystemStorage({
    directory: join(f.directory, "content"),
    keys: f.ring,
  });
  const engine = createUploadServer({ allowAnonymous: true,
    storage: restarted,
    sessionStore: f.ledger,
  });
  expect((await engine.getUpload(f.created.id)).parts).toHaveLength(1);
  const second = f.bytes.subarray(f.descriptor.chunkSize);
  await engine.receivePart(
    f.created.id,
    1,
    digest(second),
    Readable.from([second]),
  );
  await engine.finishUpload(f.created.id);
  expect(await f.collect()).toEqual(f.bytes);
  const next = await engine.createUpload(f.descriptor, "new-key");
  expect((await f.ledger.get(next.id))!.storageRef).toMatchObject({
    keyId: "v2",
  });
});
it("recovers a chunk whose receipt and session checkpoint were lost", async () => {
  const f = await fixture();
  await f.send(0);
  await rm(join(f.directory, "content", "parts", f.created.id, "0.json"));
  const session = (await f.ledger.get(f.created.id))!;
  session.parts = [];
  await f.ledger.put(session);
  expect((await f.engine.getUpload(f.created.id)).parts[0].sha256).toBe(
    digest(f.bytes.subarray(0, f.descriptor.chunkSize)),
  );
  await f.send(0);
  await f.send(1);
  await f.engine.finishUpload(f.created.id);
  expect(await f.collect()).toEqual(f.bytes);
});
it.each(["header", "ciphertext", "tag", "truncated", "trailing"])(
  "rejects %s corruption without releasing the first frame",
  async (kind) => {
    const f = await fixture();
    await f.upload();
    const path = join(f.directory, "content", "files", f.created.id, "0.enc");
    let encoded = await readFile(path);
    if (kind === "header") encoded[10] ^= 1;
    if (kind === "ciphertext") encoded[40] ^= 1;
    if (kind === "tag") encoded[40 + 65536] ^= 1;
    if (kind === "truncated") encoded = encoded.subarray(0, 100);
    if (kind === "trailing")
      encoded = Buffer.concat([encoded, Buffer.from([1])]);
    await writeFile(path, encoded);
    await expect(f.collect()).rejects.toMatchObject({
      code: "ENCRYPTION_AUTH",
    });
    if (kind !== "trailing") {
      let released = 0;
      try {
        for await (const data of await f.storage.read(f.created.id))
          released += data.length;
      } catch {}
      expect(released).toBe(0);
    }
  },
);
it("binds frames to their session and part positions", async () => {
  const f = await fixture(randomBytes(200000));
  await f.upload();
  const folder = join(f.directory, "content", "files", f.created.id);
  await copyFile(join(folder, "1.enc"), join(folder, "0.enc"));
  await expect(f.collect()).rejects.toMatchObject({ code: "ENCRYPTION_AUTH" });
});
it("rejects receipt tampering instead of skipping an untrusted chunk", async () => {
  const f = await fixture();
  await f.send(0);
  const path = join(f.directory, "content", "parts", f.created.id, "0.json");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  receipt.sha256 = "0".repeat(64);
  await writeFile(path, JSON.stringify(receipt));
  await expect(f.engine.getUpload(f.created.id)).rejects.toMatchObject({
    code: "ENCRYPTION_AUTH",
  });
});
it("keeps content when a key is missing and never falls back to plaintext", async () => {
  const f = await fixture();
  await f.upload();
  const original = f.keys.get("v1")!;
  f.keys.delete("v1");
  await expect(f.collect()).rejects.toMatchObject({
    code: "ENCRYPTION_KEY_MISSING",
  });
  f.keys.set("v1", randomBytes(32));
  await expect(f.collect()).rejects.toMatchObject({ code: "ENCRYPTION_AUTH" });
  f.keys.set("v1", original);
  expect(await f.collect()).toEqual(f.bytes);
});
it("cleans a rejected part and uses a fresh attempt salt when it is sent again", async () => {
  const f = await fixture();
  const session = (await f.ledger.get(f.created.id))!;
  const part = f.bytes.subarray(0, f.descriptor.chunkSize);
  await expect(
    f.storage.writePart(
      session,
      { index: 0, size: part.length, sha256: "0".repeat(64) },
      Readable.from([part]),
      undefined,
    ),
  ).rejects.toMatchObject({ code: "CHECKSUM" });
  const folder = join(f.directory, "content", "parts", f.created.id);
  expect(await readdir(folder)).toEqual(["reference.json"]);
  await f.send(0);
  const first = (await readFile(join(folder, "0.enc"))).subarray(8, 40);
  await rm(join(folder, "0.enc"));
  await rm(join(folder, "0.json"));
  session.parts = [];
  await f.ledger.put(session);
  await f.send(0);
  expect((await readFile(join(folder, "0.enc"))).subarray(8, 40)).not.toEqual(
    first,
  );
});
it("cancels temporary content and a fresh session can upload the same file", async () => {
  const f = await fixture();
  await f.send(0);
  await f.engine.cancelUpload(f.created.id);
  expect((await f.engine.getUpload(f.created.id)).status).toBe("canceled");
  await expect(
    readdir(join(f.directory, "content", "parts", f.created.id)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const next = await f.engine.createUpload(f.descriptor, "retry-after-cancel");
  for (let index = 0; index < 2; index++) {
    const bytes = f.bytes.subarray(index * 100000, (index + 1) * 100000);
    await f.engine.receivePart(
      next.id,
      index,
      digest(bytes),
      Readable.from([bytes]),
    );
  }
  await f.engine.finishUpload(next.id);
  expect((await f.engine.getUpload(next.id)).status).toBe("completed");
});
it("authenticates an empty file instead of storing an unauthenticated empty marker", async () => {
  const f = await fixture(Buffer.alloc(0));
  await f.upload();
  expect(await f.collect()).toEqual(Buffer.alloc(0));
  const path = join(f.directory, "content", "files", f.created.id, "0.enc");
  expect((await stat(path)).size).toBe(56);
  const data = await readFile(path);
  data[55] ^= 1;
  await writeFile(path, data);
  await expect(f.collect()).rejects.toMatchObject({ code: "ENCRYPTION_AUTH" });
});
it("recovers encrypted completion before expiring a finalizing session", async () => {
  const f = await fixture();
  await f.send(0);
  await f.send(1);
  const session = (await f.ledger.get(f.created.id))!;
  session.state = "finalizing";
  await f.ledger.put(session);
  await f.storage.finish(session, session.parts, undefined);
  session.expiresAt = Date.now() - 1;
  await f.ledger.put(session);
  await f.engine.sweepExpired();
  expect((await f.engine.getUpload(f.created.id)).status).toBe("completed");
  expect(await f.collect()).toEqual(f.bytes);
});
it("bounds decrypted frames and rejects invalid key material and path IDs", async () => {
  const f = await fixture(randomBytes(1024 * 1024), 1024 * 1024);
  await f.upload();
  for await (const frame of await f.storage.read(f.created.id))
    expect(frame.length).toBeLessThanOrEqual(65536);
  await expect(f.storage.read("../escape")).rejects.toMatchObject({
    code: "STORAGE_REFERENCE",
  });
  f.keys.set("v1", Buffer.alloc(16));
  await expect(f.collect()).rejects.toMatchObject({ code: "ENCRYPTION_KEY" });
});
it("rejects swapped sessions even with identical contents and application keys", async () => {
  const a = await fixture(Buffer.from("same"), 4),
    b = await fixture(Buffer.from("same"), 4);
  b.keys.set("v1", a.keys.get("v1")!);
  await a.upload();
  await b.upload();
  await copyFile(
    join(a.directory, "content", "files", a.created.id, "0.enc"),
    join(b.directory, "content", "files", b.created.id, "0.enc"),
  );
  await expect(b.collect()).rejects.toMatchObject({ code: "ENCRYPTION_AUTH" });
});
it("removes a partially received ciphertext when the request stream fails", async () => {
  const f = await fixture();
  const session = (await f.ledger.get(f.created.id))!;
  const body = Readable.from(
    (async function* () {
      yield f.bytes.subarray(0, 70000);
      throw new Error("Disconnected");
    })(),
  );
  await expect(
    f.storage.writePart(
      session,
      { index: 0, size: 100000, sha256: digest(f.bytes.subarray(0, 100000)) },
      body,
      undefined,
    ),
  ).rejects.toThrow("Disconnected");
  expect(
    await readdir(join(f.directory, "content", "parts", f.created.id)),
  ).toEqual(["reference.json"]);
  await f.upload();
  expect(await f.collect()).toEqual(f.bytes);
});
it("loads retained keys from the supplied request context without altering borrowed key bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "salyra-key-context-"));
  dirs.push(directory);
  const key = randomBytes(32),
    snapshot = Buffer.from(key),
    context = { tenant: "alpha" };
  const ring: EncryptionKeyring = {
    current: (value) => {
      expect(value).toBe(context);
      return { id: "tenant-key", key };
    },
    resolve: (_, value) => {
      expect(value).toBe(context);
      return key;
    },
  };
  const storage = encryptedFilesystemStorage({ directory, keys: ring });
  const f = await fixture(Buffer.from("a"), 1),
    descriptor = f.descriptor;
  const ref = await storage.begin(
    { id: "context-session", descriptor },
    context,
  );
  const session = {
    ...(await f.ledger.get(f.created.id))!,
    id: "context-session",
    storageRef: ref,
  };
  const part = await storage.writePart(
    session,
    { index: 0, size: 1, sha256: digest(Buffer.from("a")) },
    Readable.from(["a"]),
    context,
  );
  await storage.finish(session, [part], context);
  const stream = await storage.read(session.id, context);
  for await (const _ of stream) {
  }
  expect(key).toEqual(snapshot);
});
