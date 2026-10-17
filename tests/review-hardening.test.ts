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
    await expect(handlers.create(request("text/plain"))).rejects.toMatchObject(
      { status: 415, code: "CONTENT_TYPE" },
    );
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
