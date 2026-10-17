import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createUploader,
  TransferError,
  uploadActions,
  type UploadTransport,
  type UploadPersistence,
  type PersistenceSnapshot,
} from "../packages/file-uploader/src/core";
import { chunkedTransport } from "../packages/file-uploader/src/transport/chunked";
import {
  createUploadServer,
  createUploadRouter,
} from "../packages/upload-server/src";
import {
  filesystemSessionStore,
  filesystemStorage,
} from "../packages/upload-server/src/storage/filesystem";
const directories: string[] = [],
  servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(
  options: { losePart?: boolean; loseFinish?: boolean; ttl?: number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "salyra-upload-"));
  directories.push(dir);
  const storage = filesystemStorage(dir),
    sessions = filesystemSessionStore(join(dir, "sessions"));
  const engine = createUploadServer({ allowAnonymous: true,
    storage,
    sessionStore: sessions,
    sessionTTL: options.ttl,
  });
  const router = createUploadRouter(engine);
  let lostPart = false,
    lostFinish = false;
  const server = createServer(async (req, res) => {
    const end = res.end.bind(res);
    res.end = ((...args: unknown[]) => {
      if (
        options.losePart &&
        !lostPart &&
        req.method === "PUT" &&
        res.statusCode === 200
      ) {
        lostPart = true;
        res.destroy();
        return res;
      }
      if (
        options.loseFinish &&
        !lostFinish &&
        req.url?.endsWith("/complete") &&
        res.statusCode === 200
      ) {
        lostFinish = true;
        res.destroy();
        return res;
      }
      return (end as (...args: unknown[]) => typeof res)(...args);
    }) as typeof res.end;
    if (!(await router(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/uploads`;
  return { dir, engine, sessions, storage, server, url };
}
async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition did not settle");
}
function memory(): UploadPersistence & { value: PersistenceSnapshot | null } {
  return {
    value: null,
    async load() {
      return this.value && structuredClone(this.value);
    },
    async save(value) {
      this.value = structuredClone(value);
    },
  };
}
const file = (text = "abcdefghijkl") =>
  new File([text], "notes.txt", { type: "text/plain", lastModified: 10 });
const descriptor = {
  protocol: "salyra-upload/1" as const,
  name: "notes.txt",
  type: "text/plain",
  size: 8,
  lastModified: 10,
  chunkSize: 4,
};
describe("actual HTTP transfers and durable storage", () => {
  it("retries a canceled transfer on a fresh session while old cleanup is pending", async () => {
    const f = await fixture(),
      remote = chunkedTransport({ baseURL: f.url });
    let release!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failures: string[] = [];
    const store = createUploader({
      chunkSize: 4,
      transport: {
        ...remote,
        async upload(session, ctx) {
          if (
            ctx.index === 1 &&
            store.getItem(id)?.session?.id === oldSession
          ) {
            await new Promise<void>((_, reject) =>
              ctx.signal.addEventListener(
                "abort",
                () => reject(new Error("Late request failure")),
                { once: true },
              ),
            );
          }
          return remote.upload(session, ctx);
        },
        async terminate(session, ctx) {
          await cleanupGate;
          await remote.terminate!(session, ctx);
        },
      },
      onError: (error) => {
        failures.push(error.message);
      },
    });
    const [id] = await store.add([file()]);
    let oldSession = "";
    const observed: { status: string; error?: string }[] = [];
    store.subscribeItem(id, () => {
      const item = store.getItem(id)!;
      oldSession ||= item.session?.id ?? "";
      observed.push({ status: item.status, error: item.error?.message });
    });
    store.start(id);
    await waitUntil(() => store.getItem(id)!.parts.length === 1);
    const oldKey = store.getItem(id)!.requestKey;
    const cancel = store.cancel(id);
    expect(store.getItem(id)!.status).toBe("canceled");
    expect(store.getItem(id)!.error).toBeUndefined();
    expect(uploadActions(store.getItem(id)!)).toMatchObject({
      canRetry: true,
      canStart: true,
    });
    store.retry(id);
    expect(store.getItem(id)!.requestKey).not.toBe(oldKey);
    expect(store.getItem(id)!.session).toBeUndefined();
    expect(store.getItem(id)!.parts).toEqual([]);
    expect(store.getItem(id)!.uploadedBytes).toBe(0);
    await waitUntil(() => store.getItem(id)!.status === "completed");
    const newSession = store.getItem(id)!.session!.id;
    expect(newSession).not.toBe(oldSession);
    release();
    await cancel;
    expect((await f.engine.getUpload(oldSession)).status).toBe("canceled");
    expect((await f.engine.getUpload(newSession)).status).toBe("completed");
    expect(
      observed.some((item) => item.status === "failed" || item.error),
    ).toBe(false);
    expect(failures).toEqual([]);
    expect(store.getSnapshot().cleanups).toEqual([]);
    store.destroy();
  });
  it("revalidates a canceled selection before retrying and ignores its old validation", async () => {
    let finishOld!: () => void;
    let validations = 0,
      sends = 0;
    const oldValidation = new Promise<void>((resolve) => {
      finishOld = resolve;
    });
    const store = createUploader({
      transport: {
        capabilities: {
          resume: false,
          progress: false,
          parallelParts: false,
          checksums: false,
          terminate: false,
        },
        async create(ctx) {
          sends++;
          return { id: ctx.requestKey, chunkSize: 100 };
        },
        async probe() {
          throw new Error("No resume");
        },
        async upload(_, ctx) {
          return { index: 0, size: ctx.blob.size, sha256: "" };
        },
        async complete() {
          return {};
        },
      },
      async validateFile() {
        validations++;
        if (validations === 1) await oldValidation;
        else return "Rejected by validation";
      },
    });
    const pendingAdd = store.add([file()]);
    await waitUntil(() => validations === 1);
    const id = store.getSnapshot().items[0].id;
    await store.cancel(id);
    store.retry(id);
    await waitUntil(() => store.getItem(id)!.status === "failed");
    expect(store.getItem(id)!.error?.code).toBe("VALIDATION");
    finishOld();
    await pendingAdd;
    expect(store.getItem(id)!.status).toBe("failed");
    expect(sends).toBe(0);
    await store.reset(id);
    store.start(id);
    await waitUntil(() => store.getItem(id)!.status === "failed");
    expect(sends).toBe(0);
    store.destroy();
  });

  it("reconciles a saved part and completed result when their responses are lost", async () => {
    const f = await fixture({ losePart: true, loseFinish: true });
    const store = createUploader({
      transport: chunkedTransport({ baseURL: f.url }),
      chunkSize: 4,
      retry: { baseDelay: 1, jitter: false },
      autoUpload: true,
    });
    const [id] = await store.add([file()]);
    await waitUntil(() =>
      ["completed", "failed"].includes(store.getItem(id)!.status),
    );
    expect(store.getItem(id)!.status).toBe("completed");
    expect(store.getItem(id)!.uploadedBytes).toBe(12);
    expect(
      await readFile(
        join(f.dir, "files", store.getItem(id)!.session!.id),
        "utf8",
      ),
    ).toBe("abcdefghijkl");
    store.destroy();
  });
  it("resolves and cleans a session whose creation response was interrupted", async () => {
    const f = await fixture(),
      remote = chunkedTransport({ baseURL: f.url });
    let first = true,
      createdId = "";
    const transport: UploadTransport = {
      ...remote,
      async create(context) {
        const session = await remote.create(context);
        createdId = session.id;
        if (first) {
          first = false;
          await new Promise<void>((_, reject) =>
            context.signal.addEventListener(
              "abort",
              () => reject(new DOMException("Stopped", "AbortError")),
              { once: true },
            ),
          );
        }
        return session;
      },
    };
    const store = createUploader({ transport, autoUpload: true, chunkSize: 4 });
    const [id] = await store.add([file()]);
    await waitUntil(() => !!createdId);
    await store.cancel(id);
    expect((await f.engine.getUpload(createdId)).status).toBe("canceled");
    expect(store.getSnapshot().cleanups).toHaveLength(0);
    store.destroy();
  });
  it("resumes after refresh and re-selection without trusting a stale local checkpoint", async () => {
    const f = await fixture(),
      persistence = memory();
    const remote = chunkedTransport({ baseURL: f.url });
    let hold = true;
    const transport: UploadTransport = {
      ...remote,
      async upload(session, context) {
        if (context.index === 1 && hold) {
          await new Promise<void>((_, reject) =>
            context.signal.addEventListener(
              "abort",
              () => reject(new DOMException("Stopped", "AbortError")),
              { once: true },
            ),
          );
        }
        return remote.upload(session, context);
      },
    };
    const store = createUploader({
      transport,
      persistence,
      chunkSize: 4,
      autoUpload: true,
    });
    const [id] = await store.add([file()]);
    await waitUntil(() => store.getItem(id)!.uploadedBytes === 4);
    store.pause(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    store.destroy();
    hold = false;
    const next = createUploader({ transport, persistence, chunkSize: 4 });
    await next.restore();
    expect(next.getItem(id)!.status).toBe("awaiting-file");
    await next.attach(id, file());
    next.resume(id);
    await waitUntil(() => next.getItem(id)!.status === "completed");
    expect(next.getItem(id)!.session!.id).toBe(
      persistence.value!.items[0].session!.id,
    );
    next.destroy();
  });
  it("rejects a different file with the same name, length and timestamp before continuing", async () => {
    const f = await fixture(),
      session = await f.engine.createUpload(
        { ...descriptor, size: 12 },
        "candidate",
      );
    await f.engine.receivePart(
      session.id,
      0,
      sha("abcd"),
      Readable.from(["abcd"]),
    );
    const persistence = memory();
    persistence.value = {
      version: 1,
      cleanups: [],
      items: [
        {
          id: "candidate",
          requestKey: "candidate",
          metadata: {
            name: "notes.txt",
            size: 12,
            type: "text/plain",
            lastModified: 10,
          },
          status: "paused",
          session,
          parts: [],
          uploadedBytes: 0,
          transferredBytes: 0,
          totalBytes: 12,
          remainingBytes: 12,
          progress: 0,
          activeMilliseconds: 0,
          attempt: 0,
          nextRetryAt: null,
          removing: false,
        },
      ],
    };
    const store = createUploader({
      transport: chunkedTransport({ baseURL: f.url }),
      persistence,
      chunkSize: 4,
    });
    await store.restore();
    await store.attach("candidate", file("zzzzefghijkl"));
    store.resume("candidate");
    await waitUntil(() => store.getItem("candidate")!.status === "failed");
    expect(store.getItem("candidate")!.error!.code).toBe("FILE_MISMATCH");
    expect((await f.engine.getUpload(session.id)).parts).toHaveLength(1);
    store.destroy();
  });
  it("accepts out-of-order parts, verifies duplicate bodies, and finalizes only a full manifest", async () => {
    const f = await fixture(),
      session = await f.engine.createUpload(descriptor, "parts");
    await f.engine.receivePart(
      session.id,
      1,
      sha("efgh"),
      Readable.from(["efgh"]),
    );
    await expect(f.engine.finishUpload(session.id)).rejects.toMatchObject({
      code: "INCOMPLETE",
    });
    await f.engine.receivePart(
      session.id,
      0,
      sha("abcd"),
      Readable.from(["abcd"]),
    );
    await expect(
      f.engine.receivePart(session.id, 0, sha("abcd"), Readable.from(["xxxx"])),
    ).rejects.toMatchObject({ code: "PART_CONFLICT" });
    await f.engine.receivePart(
      session.id,
      0,
      sha("abcd"),
      Readable.from(["abcd"]),
    );
    const result = await f.engine.finishUpload(session.id);
    expect(await f.engine.finishUpload(session.id)).toEqual(result);
    expect(await readFile(join(f.dir, "files", session.id), "utf8")).toBe(
      "abcdefgh",
    );
  });
  it("recovers a durable part when ledger persistence fails, including a new engine instance", async () => {
    const f = await fixture(),
      session = await f.engine.createUpload(descriptor, "restart");
    const saved = (await f.sessions.get(session.id))!;
    await f.storage.writePart(
      saved,
      { index: 0, size: 4, sha256: sha("abcd") },
      Readable.from(["abcd"]),
      undefined,
    );
    const restarted = createUploadServer({ allowAnonymous: true,
      sessionStore: filesystemSessionStore(join(f.dir, "sessions")),
      storage: filesystemStorage(f.dir),
    });
    expect((await restarted.getUpload(session.id)).parts).toEqual([
      { index: 0, size: 4, sha256: sha("abcd") },
    ]);
  });
  it("does not retry validation, refuses excessive bytes and preserves failed removals", async () => {
    const f = await fixture(),
      session = await f.engine.createUpload(descriptor, "length");
    await expect(
      f.engine.receivePart(
        session.id,
        0,
        sha("abcde"),
        Readable.from(["abcde"]),
      ),
    ).rejects.toMatchObject({ code: "PART_SIZE" });
    expect((await f.engine.getUpload(session.id)).parts).toHaveLength(0);
    const store = createUploader({
      transport: chunkedTransport({ baseURL: f.url }),
      maxFileSize: 1,
      autoUpload: true,
    });
    const [id] = await store.add([file()]);
    expect(store.getItem(id)!.error!.code).toBe("VALIDATION");
    store.start(id);
    expect(store.getItem(id)!.status).toBe("failed");
    store.destroy();
  });
  it("serializes concurrent finish and cancel so a completed file cannot be deleted as temporary data", async () => {
    const f = await fixture(),
      session = await f.engine.createUpload({ ...descriptor, size: 4 }, "race");
    await f.engine.receivePart(
      session.id,
      0,
      sha("abcd"),
      Readable.from(["abcd"]),
    );
    const results = await Promise.allSettled([
      f.engine.finishUpload(session.id),
      f.engine.cancelUpload(session.id),
    ]);
    const checkpoint = await f.engine.getUpload(session.id);
    if (results[0].status === "fulfilled") {
      expect(results[1].status).toBe("rejected");
      expect(checkpoint.status).toBe("completed");
      expect(checkpoint.result).toMatchObject({ size: 4 });
    } else {
      expect(results[1].status).toBe("fulfilled");
      expect(checkpoint.status).toBe("canceled");
      expect(checkpoint.parts).toHaveLength(0);
    }
  });
  it("keeps completed removal failures visible and permits an explicit retry", async () => {
    const f = await fixture();
    let fail = true;
    const store = createUploader({
      transport: chunkedTransport({ baseURL: f.url }),
      initialFiles: [
        {
          id: "saved",
          metadata: {
            name: "saved.pdf",
            type: "application/pdf",
            size: 20,
            lastModified: 0,
          },
        },
      ],
      onRemove: async () => {
        if (fail) throw new Error("Application rejected removal");
      },
    });
    await store.remove("saved");
    expect(store.getItem("saved")!.status).toBe("completed");
    expect(store.getItem("saved")!.removeError).toBeDefined();
    fail = false;
    await store.remove("saved");
    expect(store.getItem("saved")).toBeUndefined();
    store.destroy();
  });
  it("terminates expired sessions and exposes an explicit expired state", async () => {
    const f = await fixture({ ttl: 1 }),
      session = await f.engine.createUpload(descriptor, "expires");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(f.engine.getUpload(session.id)).rejects.toMatchObject({
      status: 410,
    });
    expect((await f.sessions.get(session.id))!.state).toBe("expired");
  });
});
describe("abort and isolation", () => {
  it("cancels backoff without any further send and keeps cleanup errors after reset", async () => {
    let calls = 0;
    const transport: UploadTransport = {
      capabilities: {
        resume: false,
        progress: false,
        checksums: false,
        parallelParts: false,
        terminate: true,
      },
      async create() {
        return { id: "temporary", chunkSize: 12 };
      },
      async probe() {
        throw new Error("unused");
      },
      async upload() {
        calls++;
        throw new TransferError("Disconnected", "NETWORK");
      },
      async complete() {
        return {};
      },
      async terminate() {
        throw new Error("Cleanup unavailable");
      },
    };
    const store = createUploader({
      transport,
      autoUpload: true,
      retry: { baseDelay: 5000 },
    });
    const [id] = await store.add([file()]);
    await waitUntil(() => store.getItem(id)!.status === "retrying");
    await store.reset(id);
    expect(store.getItem(id)!.status).toBe("idle");
    expect(store.getSnapshot().cleanups[0].status).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    store.destroy();
  });
  it("ignores late responses after reset even from a transport that disregards AbortSignal", async () => {
    let release!: () => void;
    const transport: UploadTransport = {
      capabilities: {
        resume: false,
        progress: false,
        checksums: false,
        parallelParts: false,
        terminate: true,
      },
      async create() {
        await new Promise<void>((resolve) => (release = resolve));
        return { id: "old", chunkSize: 12 };
      },
      async probe() {
        throw new Error("unused");
      },
      async upload() {
        throw new Error("must not run");
      },
      async complete() {},
      async terminate() {},
    };
    const store = createUploader({ transport, autoUpload: true });
    const [id] = await store.add([file()]);
    await waitUntil(() => !!release);
    await store.reset(id);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getItem(id)!.session).toBeUndefined();
    expect(store.getItem(id)!.status).toBe("idle");
    store.destroy();
  });
});
