import { expect, it } from "vitest";
import {
  createUploader,
  type UploadTransport,
  type UploadPersistence,
  type PersistenceSnapshot,
} from "../packages/file-uploader/src/core";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  for (let count = 0; count < 200; count++) {
    if (check()) return;
    await tick();
  }
  throw new Error("State did not settle");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const file = (type = "text/plain") => new File(["abcd"], "same.txt", { type });
function transport(): UploadTransport {
  return {
    capabilities: {
      resume: false,
      progress: true,
      checksums: false,
      parallelParts: true,
      terminate: false,
    },
    async create(ctx) {
      return { id: ctx.requestKey, chunkSize: 4 };
    },
    async probe() {
      throw Error("unused");
    },
    async upload(_, ctx) {
      ctx.onProgress(ctx.blob.size);
      return { index: ctx.index, size: ctx.blob.size, sha256: "" };
    },
    async complete() {
      return { saved: true };
    },
  };
}

it("drains a thousand queued files without exceeding the shared request limit", async () => {
  const wire = transport();
  let active = 0,
    peak = 0,
    completed = 0;
  const guard = async <T>(operation: () => Promise<T>) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await tick();
      return await operation();
    } finally {
      active--;
    }
  };
  const store = createUploader({
    transport: {
      ...wire,
      create: (context) => guard(() => wire.create(context)),
      upload: (session, context) => guard(() => wire.upload(session, context)),
      complete: (session, context) =>
        guard(() => wire.complete(session, context)),
    },
    maxConcurrentFiles: 8,
    maxConcurrentChunks: 2,
    maxConcurrentRequests: 4,
    onCompleted: () => {
      completed++;
    },
  });
  try {
    await store.add(
      Array.from(
        { length: 1000 },
        (_, index) => new File(["abcd"], `${index}.txt`),
      ),
    );
    store.start();
    const deadline = Date.now() + 12_000;
    while (completed < 1000) {
      expect(Date.now()).toBeLessThan(deadline);
      await tick();
    }
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(
      store.getSnapshot().items.every((item) => item.status === "completed"),
    ).toBe(true);
  } finally {
    store.destroy();
  }
}, 15_000);

it("replacing a file aborts its previous validation before any auto upload", async () => {
  const gate = deferred();
  let validations = 0;
  let oldSignal: AbortSignal | undefined;
  let uploaded = 0;
  const wire = transport();
  const store = createUploader({
    transport: {
      ...wire,
      async upload(session, ctx) {
        uploaded++;
        return wire.upload(session, ctx);
      },
    },
    autoUpload: true,
    async validateFile(_, signal) {
      validations++;
      if (validations === 1) {
        oldSignal = signal;
        await gate.promise;
        return;
      }
      return "Replacement rejected";
    },
  });
  const adding = store.add([file()]);
  await until(() => store.getSnapshot().items.length === 1);
  const id = store.getSnapshot().items[0].id;
  await store.attach(id, file("application/octet-stream"));
  expect(oldSignal?.aborted).toBe(true);
  gate.resolve();
  await adding;
  await tick();
  expect(uploaded).toBe(0);
  expect(store.getItem(id)?.status).toBe("paused");
  store.start(id);
  await until(() => store.getItem(id)?.status === "failed");
  expect(store.getItem(id)?.error?.message).toBe("Replacement rejected");
  expect(uploaded).toBe(0);
  store.destroy();
});

it("reselecting a completed file cannot turn its saved record back into a pending transfer", async () => {
  const store = createUploader({ transport: transport() });
  try {
    const [id] = await store.add([file()]);
    store.start(id);
    await until(() => store.getItem(id)?.status === "completed");
    const completed = store.getItem(id);
    await expect(store.attach(id, file())).rejects.toMatchObject({
      code: "COMPLETED",
    });
    expect(store.getItem(id)).toBe(completed);
  } finally {
    store.destroy();
  }
});

it("a canceled transfer can be restored and reselected without contacting its canceled session", async () => {
  let saved: PersistenceSnapshot | null = null;
  const persistence: UploadPersistence = {
    async load() {
      return saved;
    },
    async save(value) {
      saved = structuredClone(value);
    },
  };
  const wire = transport();
  const first = createUploader({ transport: wire, persistence });
  const [id] = await first.add([file()]);
  await first.cancel(id);
  await tick();
  first.destroy();
  // Include a real canceled server session in the stored checkpoint.
  saved!.items[0] = {
    ...saved!.items[0],
    session: { id: "canceled-session", chunkSize: 4 },
  };
  const next = createUploader({
    persistence,
    transport: {
      ...wire,
      capabilities: { ...wire.capabilities, resume: true },
      async probe(session) {
        if (session.id === "canceled-session")
          return { status: "canceled", parts: [] };
        return { status: "open", parts: [] };
      },
    },
  });
  await next.restore();
  await next.attach(id, file());
  next.start(id);
  await until(() => ["failed", "completed"].includes(next.getItem(id)!.status));
  expect(next.getItem(id)?.status).toBe("completed");
  expect(next.getItem(id)?.session?.id).not.toBe("canceled-session");
  next.destroy();
});

it("coalesces pending persistence writes while preserving the newest durable state", async () => {
  const gate = deferred();
  let writes = 0;
  let latest: PersistenceSnapshot | undefined;
  const store = createUploader({
    transport: transport(),
    persistence: {
      async load() {
        return null;
      },
      async save(snapshot) {
        writes++;
        if (writes === 1) await gate.promise;
        latest = structuredClone(snapshot);
      },
    },
  });
  await store.restore();
  const [id] = await store.add([file()]);
  for (let i = 0; i < 100; i++) {
    await store.cancel(id);
    await store.reset(id);
  }
  gate.resolve();
  await until(
    () =>
      !!latest?.items.length &&
      latest.items[0].requestKey === store.getItem(id)?.requestKey,
  );
  expect(writes).toBeLessThanOrEqual(3);
  expect(latest!.items[0].status).toBe("idle");
  store.destroy();
});

for (const phase of ["create", "probe", "upload", "complete"] as const) {
  for (const action of ["pause", "cancel", "reset"] as const) {
    it(`${action} followed by restart ignores a late ${phase} response`, async () => {
      const gate = deferred();
      let held = false;
      let completions = 0;
      const base = transport();
      const hold = async (name: string) => {
        if (name === phase && !held) {
          held = true;
          await gate.promise;
        }
      };
      const wire: UploadTransport = {
        ...base,
        capabilities: { ...base.capabilities, resume: true, terminate: true },
        async create(ctx) {
          await hold("create");
          return base.create(ctx);
        },
        async probe() {
          await hold("probe");
          return { status: "open", parts: [] };
        },
        async upload(session, ctx) {
          await hold("upload");
          return base.upload(session, ctx);
        },
        async complete() {
          await hold("complete");
          return { saved: true };
        },
        async terminate() {},
      };
      const store = createUploader({
        transport: wire,
        onCompleted() {
          completions++;
        },
      });
      const [id] = await store.add([file()]);
      store.start(id);
      await until(() => held);
      const requestKey = store.getItem(id)!.requestKey;
      const stopping = store[action](id);
      expect(store.getItem(id)?.status).toBe(
        action === "pause"
          ? "paused"
          : action === "cancel"
            ? "canceled"
            : "idle",
      );
      store.start(id);
      gate.resolve();
      await stopping;
      await until(() => store.getItem(id)?.status === "completed");
      expect(completions).toBe(1);
      expect(store.getItem(id)?.uploadedBytes).toBe(4);
      expect(store.getItem(id)?.error).toBeUndefined();
      if (action !== "pause")
        expect(store.getItem(id)?.requestKey).not.toBe(requestKey);
      store.destroy();
    });
  }
}
