import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  createUploadServer,
  createUploadHandlers,
  UploadServerError,
  type ServerSession,
} from "../packages/upload-server/src";
import {
  filesystemSessionStore,
  filesystemStorage,
} from "../packages/upload-server/src/storage/filesystem";
import { s3Storage } from "../packages/upload-server/src/storage/s3";

async function temporary<T>(run: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "salyra-hardening-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it("refuses to start without authorize unless anonymous access is explicit", () =>
  temporary(async (dir) => {
    const parts = {
      sessionStore: filesystemSessionStore(join(dir, "s")),
      storage: filesystemStorage(join(dir, "c")),
    };
    expect(() => createUploadServer(parts)).toThrow(/authorize/);
    expect(() =>
      createUploadServer({ ...parts, allowAnonymous: true }),
    ).not.toThrow();
    expect(() =>
      createUploadServer({ ...parts, authorize: () => {} }),
    ).not.toThrow();
  }));

it("accepts upload metadata only as application/json", () =>
  temporary(async (dir) => {
    const engine = createUploadServer({
      allowAnonymous: true,
      sessionStore: filesystemSessionStore(join(dir, "s")),
      storage: filesystemStorage(join(dir, "c")),
    });
    const handlers = createUploadHandlers(engine);
    const request = (type: string) =>
      Object.assign(Readable.from([Buffer.from("{}")]), {
        headers: { "content-type": type, "idempotency-key": "k" },
      }) as unknown as IncomingMessage;
    await expect(handlers.create(request("text/plain"))).rejects.toMatchObject({
      status: 415,
      code: "CONTENT_TYPE",
    });
    // the right type gets past the check, to the descriptor validation
    await expect(
      handlers.create(request("application/json; charset=utf-8")),
    ).rejects.toMatchObject({ status: 400, code: "DESCRIPTOR" });
  }));

it("reclaims a lock left by an earlier run with the same PID", () =>
  temporary(async (dir) => {
    const store = filesystemSessionStore(dir);
    await mkdir(dir, { recursive: true });
    for (const [key, owner] of [
      ["restarted", `${process.pid}:an-earlier-start`],
      ["old-format", String(process.pid)],
    ]) {
      const lock = join(
        dir,
        `${createHash("sha256").update(key).digest("hex")}.lock`,
      );
      await symlink(owner, lock);
      const started = Date.now();
      await expect(store.transaction(key, async () => "done")).resolves.toBe(
        "done",
      );
      expect(Date.now() - started).toBeLessThan(5000);
    }
  }));

it("S3 objects are attachments of a checked type; removal stays in its bucket", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = {
    async send(command: { constructor: { name: string }; input: object }) {
      calls.push({
        name: command.constructor.name,
        input: command.input as Record<string, unknown>,
      });
      return { UploadId: "multipart" };
    },
  };
  const journal = {
    async getReference() {
      return undefined;
    },
    async putReference() {},
    async get() {
      return [];
    },
    async put() {},
    async remove() {},
  };
  const session = {
    id: "abc",
    key: "abc",
    expiresAt: Date.now() + 10000,
    state: "open",
    parts: [],
    descriptor: {
      protocol: "salyra-upload/1",
      name: "page.html",
      type: "text/html",
      size: 10,
      lastModified: 0,
      chunkSize: 5 * 1024 * 1024,
    },
  } as unknown as ServerSession;

  const plain = s3Storage({ client: client as never, bucket: "docs", journal });
  await plain.begin(session, undefined);
  expect(calls.at(-1)!.input).toMatchObject({
    ContentType: "application/octet-stream",
    ContentDisposition: "attachment",
  });

  const images = s3Storage({
    client: client as never,
    bucket: "docs",
    journal,
    contentType: (d) => (d.type === "image/png" ? d.type : undefined),
  });
  await images.begin(session, undefined);
  expect(calls.at(-1)!.input.ContentType).toBe("application/octet-stream");
  await images.begin(
    {
      ...session,
      descriptor: { ...session.descriptor, type: "image/png" },
    },
    undefined,
  );
  expect(calls.at(-1)!.input.ContentType).toBe("image/png");

  for (const foreign of [
    { bucket: "other", key: "uploads/abc" },
    { bucket: "docs", key: "secrets/abc" },
    { bucket: "docs", key: "uploads/../x" },
  ])
    await expect(plain.remove!(foreign, undefined)).rejects.toBeInstanceOf(
      UploadServerError,
    );
  await plain.remove!({ bucket: "docs", key: "uploads/abc" }, undefined);
  expect(calls.at(-1)).toMatchObject({
    name: "DeleteObjectCommand",
    input: { Bucket: "docs", Key: "uploads/abc" },
  });
});

const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const descriptor = (size: number, chunkSize: number) => ({
  protocol: "salyra-upload/1" as const,
  name: "notes.txt",
  type: "text/plain",
  size,
  lastModified: 0,
  chunkSize,
});

it("a slow chunk does not hold the session: other chunks are stored meanwhile", () =>
  temporary(async (dir) => {
    const engine = createUploadServer({
      allowAnonymous: true,
      sessionStore: filesystemSessionStore(join(dir, "s")),
      storage: filesystemStorage(join(dir, "c")),
    });
    const { id } = await engine.createUpload(descriptor(8, 4), "slow");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = Readable.from(
      (async function* () {
        yield Buffer.from("ab");
        await gate;
        yield Buffer.from("cd");
      })(),
    );
    const first = engine.receivePart(id, 0, sha("abcd"), slow);
    // the second chunk completes while the first is still streaming
    await expect(
      engine.receivePart(
        id,
        1,
        sha("efgh"),
        Readable.from([Buffer.from("efgh")]),
      ),
    ).resolves.toMatchObject({ index: 1 });
    release();
    await expect(first).resolves.toMatchObject({ index: 0 });
    await expect(engine.finishUpload(id)).resolves.toMatchObject({
      size: 8,
      sha256: sha("abcdefgh"),
    });
  }));

it("the receipt journal keeps every chunk written side by side", () =>
  temporary(async (dir) => {
    const { filesystemReceiptJournal } =
      await import("../packages/upload-server/src/storage/filesystem");
    const journal = filesystemReceiptJournal(dir);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        journal.put("upload", {
          index,
          size: 1,
          sha256: sha(String(index)),
          reference: { etag: String(index) },
        }),
      ),
    );
    expect((await journal.get("upload")).map((part) => part.index)).toEqual(
      Array.from({ length: 20 }, (_, index) => index),
    );
  }));

it("progress extends the expiry; finished records go after retainFinished", () =>
  temporary(async (dir) => {
    const sessions = filesystemSessionStore(join(dir, "s"));
    const engine = createUploadServer({
      allowAnonymous: true,
      sessionStore: sessions,
      storage: filesystemStorage(join(dir, "c")),
      sessionTTL: 60_000,
      retainFinished: 1,
    });
    const created = await engine.createUpload(descriptor(8, 4), "ttl");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await engine.receivePart(
      created.id,
      0,
      sha("abcd"),
      Readable.from([Buffer.from("abcd")]),
    );
    expect((await engine.getUpload(created.id)).expiresAt).toBeGreaterThan(
      created.expiresAt,
    );
    await engine.cancelUpload(created.id);
    const record = (await sessions.get(created.id))!;
    await sessions.put({ ...record, expiresAt: Date.now() - 10 });
    await engine.sweepExpired();
    expect(await sessions.get(created.id)).toBeUndefined();
  }));
