import { expect, it } from "vitest";
import {
  createUploader,
  type UploadTransport,
  type UploadPersistence,
  type PersistenceSnapshot,
} from "../packages/file-uploader/src/core";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error("Transfer did not settle");
}
function transport(): UploadTransport {
  return {
    capabilities: {
      resume: false,
      progress: true,
      parallelParts: true,
      checksums: false,
      terminate: false,
    },
    async create(ctx) {
      return { id: ctx.requestKey, chunkSize: 2 };
    },
    async probe() {
      throw new Error("No resume");
    },
    async upload(_, ctx) {
      for (let i = 0; i < 40; i++) ctx.onProgress((ctx.blob.size * i) / 40);
      await sleep(20);
      return { index: ctx.index, size: ctx.blob.size, sha256: "" };
    },
    async complete() {
      return { saved: true };
    },
  };
}
it("keeps per-item listeners isolated and coalesces noisy progress", async () => {
  const store = createUploader({
    transport: transport(),
    progressInterval: 100,
    initialFiles: Array.from({ length: 500 }, (_, id) => ({
      id: `saved-${id}`,
      metadata: {
        name: `${id}.txt`,
        size: 1,
        type: "text/plain",
        lastModified: 0,
      },
    })),
  });
  let unrelated = 0,
    updated = 0;
  const stop = store.subscribeItem("saved-12", () => unrelated++);
  const [id] = await store.add([new File(["abcd"], "new.txt")]);
  store.subscribeItem(id, () => updated++);
  store.start(id);
  await until(() => store.getItem(id)?.status === "completed");
  expect(unrelated).toBe(0);
  expect(updated).toBeLessThan(20);
  stop();
  store.destroy();
});
it("enforces one request pool across files and their concurrent chunks", async () => {
  const base = transport();
  let active = 0,
    peak = 0;
  const guarded = async <T>(fn: () => Promise<T>) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await sleep(10);
      return await fn();
    } finally {
      active--;
    }
  };
  const store = createUploader({
    transport: {
      ...base,
      create: (ctx) => guarded(() => base.create(ctx)),
      upload: (session, ctx) => guarded(() => base.upload(session, ctx)),
      complete: (session, ctx) => guarded(() => base.complete(session, ctx)),
    },
    maxConcurrentFiles: 3,
    maxConcurrentChunks: 3,
    maxConcurrentRequests: 2,
    autoUpload: true,
  });
  await store.add(
    Array.from({ length: 3 }, (_, id) => new File(["abcdef"], "file-" + id)),
  );
  await until(() =>
    store.getSnapshot().items.every((item) => item.status === "completed"),
  );
  expect(peak).toBe(2);
  expect(active).toBe(0);
  store.destroy();
});
it("finishes application removal when interaction flags change during its request", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const record = {
    id: "saved",
    metadata: {
      name: "saved.txt",
      size: 3,
      type: "text/plain",
      lastModified: 0,
    },
  };
  const store = createUploader({
    transport: transport(),
    initialFiles: [record],
    onRemove: () => gate,
  });
  const pending = store.remove("saved");
  store.setOptions({ readOnly: true });
  finish();
  await pending;
  expect(store.getItem("saved")).toBeUndefined();
  store.addExisting([record, record]);
  expect(store.getSnapshot().items).toHaveLength(1);
  store.destroy();
});
it("restores persistence before a new selection can overwrite saved records", async () => {
  const existing = createUploader({ transport: transport() });
  await existing.add([new File(["old"], "old.txt")]);
  let saved: PersistenceSnapshot = {
    version: 1,
    items: existing
      .getSnapshot()
      .items.map(({ file, bytesPerSecond, etaSeconds, ...item }) => item),
    cleanups: [],
  };
  existing.destroy();
  let loaded = false;
  const persistence: UploadPersistence = {
    async load() {
      await sleep(20);
      loaded = true;
      return structuredClone(saved);
    },
    async save(value) {
      expect(loaded).toBe(true);
      saved = structuredClone(value);
    },
  };
  const store = createUploader({ transport: transport(), persistence });
  await store.add([new File(["new"], "new.txt")]);
  expect(store.getSnapshot().items.map((item) => item.metadata.name)).toEqual([
    "old.txt",
    "new.txt",
  ]);
  await sleep(20);
  expect(saved.items).toHaveLength(2);
  store.destroy();
});

it("does not invalidate a completed transfer when application notifications reject", async () => {
  const notifications: string[] = [];
  const store = createUploader({
    transport: transport(),
    async onCompleted() {
      throw new Error("Application notification failed");
    },
    async onError(error) {
      notifications.push(error.message);
      throw new Error("Application logger failed");
    },
  });
  const ids = await store.add([
    new File(["first"], "first.txt"),
    new File(["second"], "second.txt"),
  ]);
  store.start();
  await until(
    () =>
      ids.every((id) => store.getItem(id)?.status === "completed") &&
      notifications.length === 2,
  );
  expect(notifications).toEqual([
    "Application notification failed",
    "Application notification failed",
  ]);
  store.destroy();
});
