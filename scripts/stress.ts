import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openAsBlob, createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createUploader } from "../packages/file-uploader/src/core";
import { chunkedTransport } from "../packages/file-uploader/src/transport/chunked";
import {
  createUploadServer,
  createUploadRouter,
} from "../packages/upload-server/src";
import {
  filesystemSessionStore,
  filesystemStorage,
} from "../packages/upload-server/src/storage/filesystem";

import { encryptedFilesystemStorage } from "../packages/upload-server/src/storage/encryption";

// A sparse disk fixture avoids allocating the file in RAM before the test starts.
const size = Number(process.env.SALYRA_STRESS_BYTES ?? 2 * 1024 ** 3);
assert(Number.isSafeInteger(size) && size > 0);
const directory = await mkdtemp(join(tmpdir(), "salyra-upload-stress-"));
const server = createServer();
let stop: ReturnType<typeof setInterval> | undefined;
let uploader: ReturnType<typeof createUploader> | undefined;
try {
  const source = join(directory, "source.bin");
  const fileHandle = await open(source, "wx");
  await fileHandle.truncate(size);
  // Different data at each end also detects assembly order mistakes.
  await fileHandle.write(Buffer.from("start"), 0, 5, 0);
  await fileHandle.write(Buffer.from("finish"), 0, 6, size - 6);
  await fileHandle.close();
  const file = Object.assign(await openAsBlob(source), {
    name: "large-file.bin",
    lastModified: 0,
  }) as File;
  const encrypted = process.env.SALYRA_STRESS_ENCRYPTED === "1";
  const key = randomBytes(32);
  const protectedStorage = encryptedFilesystemStorage({
    directory: join(directory, "storage"),
    keys: { current: () => ({ id: "stress-key", key }), resolve: () => key },
  });
  const engine = createUploadServer({ allowAnonymous: true,
    sessionStore: filesystemSessionStore(join(directory, "sessions")),
    storage: encrypted
      ? protectedStorage
      : filesystemStorage(join(directory, "storage")),
    maxFileSize: size,
    maxChunkSize: 8 * 1024 ** 2,
  });
  const route = createUploadRouter(engine);
  server.on("request", (req, res) => {
    void route(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const before = process.memoryUsage().rss;
  let peak = before;
  stop = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 20);
  const started = performance.now();
  uploader = createUploader({
    transport: chunkedTransport({
      baseURL: `http://127.0.0.1:${port}/uploads`,
      fetch,
    }),
    chunkSize: 8 * 1024 ** 2,
    maxConcurrentChunks: 2,
    maxConcurrentRequests: 2,
    autoUpload: false,
  });
  const [id] = await uploader.add([file]);
  uploader.start(id);
  const deadline = Date.now() + (encrypted ? 300_000 : 180_000);
  while (uploader.getItem(id)?.status !== "completed") {
    const item = uploader.getItem(id)!;
    assert(
      !["failed", "expired"].includes(item.status),
      JSON.stringify(item.error),
    );
    assert(Date.now() < deadline, "Large file upload timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const item = uploader.getItem(id)!;
  assert.equal(item.uploadedBytes, size);
  assert.equal(item.parts.length, Math.ceil(size / (8 * 1024 ** 2)));
  async function hash(path: string) {
    const digest = createHash("sha256");
    for await (const bytes of createReadStream(path)) digest.update(bytes);
    return digest.digest("hex");
  }
  assert.equal(
    await hash(source),
    encrypted
      ? await (async () => {
          const digest = createHash("sha256");
          for await (const bytes of await protectedStorage.read(
            item.session!.id,
          ))
            digest.update(bytes);
          return digest.digest("hex");
        })()
      : await hash(join(directory, "storage", "files", item.session!.id)),
  );
  const report = {
    encrypted,
    bytes: size,
    chunkBytes: 8 * 1024 ** 2,
    parallelChunks: 2,
    elapsedSeconds: Math.round((performance.now() - started) / 100) / 10,
    baselineRSSMiB: Math.round(before / 1024 ** 2),
    peakRSSMiB: Math.round(peak / 1024 ** 2),
    extraRSSMiB: Math.round((peak - before) / 1024 ** 2),
    sha256Verified: true,
  };
  // Includes both the HTTP client and the streaming server in this one process.
  assert(peak - before < 384 * 1024 ** 2, JSON.stringify(report));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (stop) clearInterval(stop);
  uploader?.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
