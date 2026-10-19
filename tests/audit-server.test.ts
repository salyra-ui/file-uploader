import { expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createUploadServer,
  UploadServerError,
  type SessionStore,
  type ServerSession,
} from "../packages/upload-server/src";
import { filesystemStorage } from "../packages/upload-server/src/storage/filesystem";

const hash = createHash("sha256").update("abcd").digest("hex");
const descriptor = {
  protocol: "salyra-upload/1" as const,
  name: "test.txt",
  type: "text/plain",
  size: 4,
  lastModified: 0,
  chunkSize: 4,
};
function sessions(): SessionStore {
  const values = new Map<string, ServerSession>();
  const locks = new Set<string>();
  return {
    async get(id) {
      const value = values.get(id);
      return value && structuredClone(value);
    },
    async put(value) {
      values.set(value.id, structuredClone(value));
    },
    async *list() {
      for (const value of values.values()) yield structuredClone(value);
    },
    async transaction(key, operation) {
      if (locks.has(key)) throw Error("Session transaction was re-entered");
      locks.add(key);
      try {
        return await operation();
      } finally {
        locks.delete(key);
      }
    },
  };
}

it("delivers events after releasing session transactions so callbacks can inspect the committed session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "salyra-events-"));
  const notifications: string[] = [];
  const errors: unknown[] = [];
  try {
    const engine = createUploadServer({ allowAnonymous: true,
      sessionStore: sessions(),
      storage: filesystemStorage(dir),
      async onEvent(event) {
        const value = await engine.getUpload(event.session.id);
        notifications.push(event.type + ":" + value.status);
      },
      onNotificationError(error) {
        errors.push(error);
      },
    });
    const first = await engine.createUpload(descriptor, "events");
    await engine.receivePart(first.id, 0, hash, Readable.from(["abcd"]));
    await engine.finishUpload(first.id);
    const second = await engine.createUpload(descriptor, "cancel");
    await engine.cancelUpload(second.id);
    expect(errors).toEqual([]);
    expect(notifications).toEqual([
      "created:open",
      "part-stored:open",
      "completed:completed",
      "created:open",
      "canceled:canceled",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["probe", "sweep", "create"])(
  "recovers a committed result after the finalizing ledger expires via %s",
  async (operation) => {
    const dir = await mkdtemp(join(tmpdir(), "salyra-expiration-"));
    const ledger = sessions();
    const storage = filesystemStorage(dir);
    try {
      const engine = createUploadServer({ allowAnonymous: true, sessionStore: ledger, storage });
      const created = await engine.createUpload(descriptor, "late-ledger");
      await engine.receivePart(created.id, 0, hash, Readable.from(["abcd"]));
      const value = (await ledger.get(created.id))!;
      value.state = "finalizing";
      await ledger.put(value);
      const result = await storage.finish(value, value.parts, undefined);
      value.expiresAt = Date.now() - 1;
      await ledger.put(value);
      if (operation === "sweep") await engine.sweepExpired();
      if (operation === "create")
        expect((await engine.createUpload(descriptor, "late-ledger")).id).toBe(
          created.id,
        );
      const checkpoint = await engine.getUpload(created.id);
      expect(checkpoint.status).toBe("completed");
      expect(checkpoint.result).toEqual(result);
      await expect(engine.cancelUpload(created.id)).rejects.toMatchObject({
        code: "COMPLETED",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("isolates identical idempotency keys by owner and authorizes every session operation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "salyra-auth-"));
  const ledger = sessions();
  const owners = new Map<string, string>();
  try {
    const engine = createUploadServer<string>({
      sessionStore: ledger,
      storage: filesystemStorage(dir),
      scope: (owner) => owner ?? "",
      authorize(operation, session, owner) {
        if (!owner || (session && owners.get(session.id) !== owner))
          throw new UploadServerError(403, "AUTH", "Not allowed");
      },
      onEvent(event, owner) {
        if (event.type === "created") owners.set(event.session.id, owner!);
      },
    });
    const a = await engine.createUpload(descriptor, "shared-key", "alice");
    const b = await engine.createUpload(descriptor, "shared-key", "bob");
    expect(a.id).not.toBe(b.id);
    for (const operation of [
      () => engine.getUpload(a.id, "bob"),
      () => engine.receivePart(a.id, 0, hash, Readable.from(["abcd"]), "bob"),
      () => engine.finishUpload(a.id, "bob"),
      () => engine.cancelUpload(a.id, "bob"),
    ])
      await expect(operation()).rejects.toMatchObject({ status: 403 });
    expect((await engine.getUpload(a.id, "alice")).parts).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
