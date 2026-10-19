import type {
  Checkpoint,
  CleanupRecord,
  FileMetadata,
  PartReceipt,
  PersistenceSnapshot,
  TransportContext,
  UploadItem,
  UploadSession,
  UploaderOptions,
  UploaderSnapshot,
  UploaderStore,
} from "./types";
import {
  abortError,
  delay,
  digest,
  errorValue,
  isAbort,
  RequestPool,
  retryable,
  TransferError,
} from "./errors";
const uid = () => crypto.randomUUID();
const metadataOf = (file: File): FileMetadata => ({
  name: file.name,
  size: file.size,
  type: file.type,
  lastModified: file.lastModified,
});
function positive(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}
function accepts(file: File, rule?: string) {
  return (
    !rule ||
    rule.split(",").some((value) => {
      const token = value.trim().toLowerCase();
      return token === "*/*" || token === "*"
        ? true
        : token.startsWith(".")
          ? file.name.toLowerCase().endsWith(token)
          : token.endsWith("/*")
            ? file.type.toLowerCase().startsWith(token.slice(0, -1))
            : file.type.toLowerCase() === token;
    })
  );
}
interface Run {
  generation: number;
  controller: AbortController;
  started: number;
  initialActive: number;
  inflight: Map<number, number>;
  samples: Array<[number, number]>;
  lastNotice: number;
  lastMetrics: number;
  metricsTimer?: ReturnType<typeof setTimeout>;
  noticeTimer?: ReturnType<typeof setTimeout>;
}
/** No browser I/O occurs until add, restore or start. Create one store per SSR tree. */
export function createUploader(options: UploaderOptions): UploaderStore {
  const transport = options.transport;
  for (const [name, value] of Object.entries({
    maxFileSize: options.maxFileSize,
    maxTotalSize: options.maxTotalSize,
    maxFiles: options.maxFiles,
    requestTimeout: options.requestTimeout,
    progressInterval: options.progressInterval,
    baseDelay: options.retry?.baseDelay,
    maxDelay: options.retry?.maxDelay,
  })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new RangeError(`${name} must be a non-negative integer`);
  }
  const chunkSize = positive("chunkSize", options.chunkSize ?? 5 * 1024 * 1024);
  const maxFiles = positive(
    "maxConcurrentFiles",
    options.maxConcurrentFiles ?? 2,
  );
  const maxChunks = positive(
    "maxConcurrentChunks",
    options.maxConcurrentChunks ?? 1,
  );
  if (maxChunks > 1 && !transport.capabilities.parallelParts)
    throw new Error("The transport does not support parallel parts");
  const pool = new RequestPool(
    positive("maxConcurrentRequests", options.maxConcurrentRequests ?? 4),
  );
  const attempts = positive(
    "retry.maxAttempts",
    options.retry?.maxAttempts ?? 4,
  );
  const interval = Math.max(0, options.progressInterval ?? 100);
  let state: UploaderSnapshot = {
    items: [],
    cleanups: [],
    disabled: options.disabled ?? false,
    readOnly: options.readOnly ?? false,
    restored: false,
  };
  const listeners = new Set<() => void>(),
    itemListeners = new Map<string, Set<() => void>>();
  const runs = new Map<string, Run>(),
    generations = new Map<string, number>(),
    validation = new Map<string, AbortController>();
  const auxiliary = new Set<AbortController>();
  const validated = new Set<string>();
  let destroyed = false,
    active = 0,
    saveChain = Promise.resolve(),
    restoreTask: Promise<void> | undefined;
  let idsSnapshot = "";
  let pendingSave: PersistenceSnapshot | undefined;
  let saving = false;
  function assertAlive() {
    if (destroyed) throw new Error("Uploader is destroyed");
  }
  const itemIndexes = new Map<string, number>();
  const getItem = (id: string) => {
    const index = itemIndexes.get(id);
    return index === undefined ? undefined : state.items[index];
  };
  const mutable = () => !state.disabled && !state.readOnly && !destroyed;
  function notify(id?: string, collection = false) {
    if (destroyed) return;
    if (id) itemListeners.get(id)?.forEach((fn) => fn());
    listeners.forEach((fn) => fn());
  }
  function reportError(
    error: ReturnType<typeof errorValue>,
    item?: UploadItem,
  ) {
    // Application notifications cannot change a committed transfer or break the queue.
    try {
      if (!destroyed)
        void Promise.resolve(options.onError?.(error, item)).catch(() => {});
    } catch {
      /* The error is already available in state. */
    }
  }
  function persist() {
    if (!options.persistence || destroyed || !state.restored) return;
    const adapter = options.persistence;
    const snapshot: PersistenceSnapshot = {
      version: 1,
      items: state.items.map(
        ({ file, bytesPerSecond, etaSeconds, ...item }) => ({
          ...item,
          session: item.session && {
            id: item.session.id,
            chunkSize: item.session.chunkSize,
            expiresAt: item.session.expiresAt,
          },
        }),
      ),
      cleanups: state.cleanups.map((cleanup) => ({
        ...cleanup,
        session: cleanup.session && {
          id: cleanup.session.id,
          chunkSize: cleanup.session.chunkSize,
          expiresAt: cleanup.session.expiresAt,
        },
      })),
    };
    pendingSave = snapshot;
    if (saving) return;
    saving = true;
    saveChain = saveChain.then(async () => {
      try {
        // Retain the newest pending checkpoint instead of queueing every intermediate snapshot.
        while (pendingSave) {
          const next = pendingSave;
          pendingSave = undefined;
          try {
            await adapter.save(next);
          } catch (error) {
            if (!destroyed) {
              state = { ...state, persistenceError: errorValue(error) };
              notify();
            }
          }
        }
      } finally {
        saving = false;
      }
    });
  }
  function patch(
    id: string,
    update: Partial<UploadItem>,
    durable = false,
    visual = false,
  ) {
    const item = getItem(id);
    if (!item || destroyed) return;
    const updated = { ...item, ...update };
    const items = state.items.slice();
    items[itemIndexes.get(id)!] = updated;
    state = { ...state, items };
    if (durable) persist();
    const run = runs.get(id);
    if (visual && run && Date.now() - run.lastNotice < interval) {
      run.noticeTimer ??= setTimeout(
        () => {
          run.noticeTimer = undefined;
          run.lastNotice = Date.now();
          notify(id);
        },
        interval - (Date.now() - run.lastNotice),
      );
    } else {
      if (run?.noticeTimer) {
        clearTimeout(run.noticeTimer);
        run.noticeTimer = undefined;
      }
      if (run) run.lastNotice = Date.now();
      notify(id);
    }
  }
  function collection(items: readonly UploadItem[]) {
    itemIndexes.clear();
    items.forEach((item, index) => itemIndexes.set(item.id, index));
    state = { ...state, items };
    const ids = items.map((item) => item.id).join("|");
    if (ids !== idsSnapshot) {
      idsSnapshot = ids;
      notify(undefined, true);
    }
    persist();
  }
  const baseItem = (
    id: string,
    metadata: FileMetadata,
    file?: File,
  ): UploadItem => ({
    id,
    requestKey: uid(),
    metadata,
    file,
    status: "idle",
    session: undefined,
    result: undefined,
    error: undefined,
    removeError: undefined,
    parts: [],
    uploadedBytes: 0,
    transferredBytes: 0,
    totalBytes: metadata.size,
    remainingBytes: metadata.size,
    progress: transport.capabilities.progress ? 0 : null,
    bytesPerSecond: null,
    etaSeconds: null,
    activeMilliseconds: 0,
    attempt: 0,
    nextRetryAt: null,
    removing: false,
  });
  state = {
    ...state,
    items: Array.from(
      new Map(
        (options.initialFiles ?? []).map((item) => [
          item.id,
          {
            ...baseItem(item.id, item.metadata),
            status: "completed" as const,
            result: item.result,
            uploadedBytes: item.metadata.size,
            transferredBytes: item.metadata.size,
            remainingBytes: 0,
            progress: 100,
          },
        ]),
      ).values(),
    ),
  };
  state.items.forEach((item, index) => itemIndexes.set(item.id, index));
  idsSnapshot = state.items.map((item) => item.id).join("|");
  function current(id: string, run: Run) {
    return (
      !destroyed &&
      runs.get(id) === run &&
      (generations.get(id) ?? 0) === run.generation &&
      !run.controller.signal.aborted
    );
  }
  function context(item: UploadItem, signal: AbortSignal): TransportContext {
    return { signal, metadata: item.metadata, requestKey: item.requestKey };
  }
  async function request<T>(
    id: string,
    run: Run,
    operation: (ctx: TransportContext) => Promise<T>,
  ): Promise<T> {
    if (!current(id, run)) throw abortError();
    const item = getItem(id)!;
    return pool.run(run.controller.signal, async () => {
      const ctl = new AbortController();
      const stop = () => ctl.abort(run.controller.signal.reason);
      run.controller.signal.addEventListener("abort", stop, { once: true });
      let timedOut = false;
      const timer = options.requestTimeout
        ? setTimeout(() => {
            timedOut = true;
            ctl.abort();
          }, options.requestTimeout)
        : undefined;
      try {
        const result = await operation(context(item, ctl.signal));
        if (!current(id, run)) throw abortError();
        return result;
      } catch (error) {
        if (timedOut && !run.controller.signal.aborted)
          throw new TransferError("Upload request timed out", "TIMEOUT");
        throw error;
      } finally {
        clearTimeout(timer);
        run.controller.signal.removeEventListener("abort", stop);
      }
    });
  }
  async function retryOperation<T>(
    id: string,
    run: Run,
    status: UploadItem["status"],
    operation: () => Promise<T>,
    reconcile?: () => Promise<{ found: boolean; value?: T }>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (!current(id, run)) throw abortError();
      patch(id, { status, attempt, nextRetryAt: null });
      try {
        return await operation();
      } catch (error) {
        if (!current(id, run) || isAbort(error)) throw error;
        // Reconcile even the final attempt. The server may already have committed it.
        if (reconcile && (options.retry?.shouldRetry ?? retryable)(error)) {
          const result = await reconcile();
          if (result.found) return result.value as T;
        }
        if (
          attempt >= attempts ||
          !(options.retry?.shouldRetry ?? retryable)(error)
        )
          throw error;
        const local = Math.min(
          options.retry?.maxDelay ?? 30000,
          (options.retry?.baseDelay ?? 1000) * 2 ** (attempt - 1),
        );
        const wait = Math.max(
          error instanceof TransferError ? (error.retryAfter ?? 0) : 0,
          local *
            (options.retry?.jitter === false ? 1 : 0.5 + Math.random() * 0.5),
        );
        patch(id, {
          status: "retrying",
          bytesPerSecond: null,
          etaSeconds: null,
          error: errorValue(error),
          attempt,
          nextRetryAt: Date.now() + wait,
        });
        await delay(wait, run.controller.signal);
      }
    }
    throw new Error("Retry exhausted");
  }
  function checkpoint(item: UploadItem, value: Checkpoint) {
    if (
      !value ||
      !Array.isArray(value.parts) ||
      !["open", "finalizing", "completed", "canceled", "expired"].includes(
        value.status,
      )
    )
      throw new TransferError(
        "Server returned an invalid checkpoint",
        "CHECKPOINT",
      );
    if (value.status === "expired")
      throw new TransferError("Upload session expired", "EXPIRED", 410);
    if (value.status === "canceled")
      throw new TransferError("Upload session was canceled", "CANCELED", 409);
    const size = item.session!.chunkSize,
      count = Math.max(1, Math.ceil(item.totalBytes / size)),
      seen = new Set<number>();
    for (const part of value.parts) {
      if (
        !Number.isInteger(part.index) ||
        part.index < 0 ||
        part.index >= count ||
        seen.has(part.index) ||
        part.size !== Math.min(size, item.totalBytes - part.index * size) ||
        !/^[a-f0-9]{64}$/.test(part.sha256)
      )
        throw new TransferError(
          "Server returned an invalid checkpoint",
          "CHECKPOINT",
        );
      seen.add(part.index);
    }
    return value.parts.slice().sort((a, b) => a.index - b.index);
  }
  function scheduleMetrics(id: string, run: Run) {
    const elapsed = Date.now() - run.lastMetrics;
    if (elapsed >= interval) metrics(id, run);
    else
      run.metricsTimer ??= setTimeout(() => {
        run.metricsTimer = undefined;
        metrics(id, run);
      }, interval - elapsed);
  }
  function metrics(id: string, run: Run, parts?: readonly PartReceipt[]) {
    clearTimeout(run.metricsTimer);
    run.metricsTimer = undefined;
    run.lastMetrics = Date.now();
    const item = getItem(id);
    if (!item || !current(id, run)) return;
    const receipts = parts ?? item.parts,
      durable = receipts.reduce((sum, part) => sum + part.size, 0),
      confirmed = new Set(receipts.map((p) => p.index));
    const transferred = Math.min(
      item.totalBytes,
      durable +
        [...run.inflight].reduce(
          (sum, [index, bytes]) => sum + (confirmed.has(index) ? 0 : bytes),
          0,
        ),
    );
    const now = Date.now();
    run.samples.push([now, transferred]);
    run.samples = run.samples.filter(([time]) => time >= now - 5000);
    const oldest = run.samples[0],
      span = now - oldest[0];
    const speed =
      span >= 500 && transferred > oldest[1]
        ? (transferred - oldest[1]) / (span / 1000)
        : null;
    patch(
      id,
      {
        parts: receipts,
        uploadedBytes: durable,
        transferredBytes: transferred,
        remainingBytes: Math.max(0, item.totalBytes - durable),
        progress: transport.capabilities.progress
          ? item.totalBytes
            ? (transferred / item.totalBytes) * 100
            : 100
          : null,
        bytesPerSecond: speed,
        etaSeconds: speed ? (item.totalBytes - transferred) / speed : null,
        activeMilliseconds: run.initialActive + now - run.started,
      },
      !!parts,
      !parts,
    );
  }
  async function probe(id: string, run: Run): Promise<Checkpoint> {
    const item = getItem(id)!;
    const value = await retryOperation(id, run, "verifying", () =>
      request(id, run, (ctx) => transport.probe(item.session!, ctx)),
    );
    metrics(id, run, checkpoint(item, value));
    return value;
  }
  async function execute(id: string, run: Run) {
    let item = getItem(id)!;
    if (!item.session) {
      if (options.persistence) await saveChain;
      if (!current(id, run)) throw abortError();
      const session = await retryOperation(id, run, "uploading", () =>
        request(id, run, (ctx) =>
          transport.create({
            ...ctx,
            chunkSize: transport.capabilities.resume
              ? chunkSize
              : Math.max(1, item.totalBytes),
          }),
        ),
      );
      if (
        typeof session?.id !== "string" ||
        !session.id ||
        !Number.isSafeInteger(session.chunkSize) ||
        session.chunkSize < 1
      )
        throw new TransferError(
          "Server returned an invalid upload session",
          "SESSION",
        );
      patch(id, { session }, true);
      item = getItem(id)!;
    }
    if (!transport.capabilities.resume && item.parts.length) {
      run.inflight.clear();
      patch(
        id,
        {
          parts: [],
          uploadedBytes: 0,
          transferredBytes: 0,
          progress: transport.capabilities.progress ? 0 : null,
        },
        true,
      );
    }
    if (transport.capabilities.resume) {
      const remote = await probe(id, run);
      item = getItem(id)!;
      // Check every committed chunk before reusing any remote data, including completed sessions.
      for (const part of item.parts) {
        run.controller.signal.throwIfAborted();
        const hash = await digest(
          item.file!.slice(
            part.index * item.session!.chunkSize,
            part.index * item.session!.chunkSize + part.size,
          ),
        );
        if (hash !== part.sha256)
          throw new TransferError(
            "This file does not match the saved upload. Choose the original file or reset the transfer.",
            "FILE_MISMATCH",
          );
      }
      if (!current(id, run)) throw abortError();
      if (remote.status === "completed") {
        finish(id, run, remote.result);
        return;
      }
    }
    item = getItem(id)!;
    const size = item.session!.chunkSize,
      count = Math.max(1, Math.ceil(item.totalBytes / size));
    const done = new Set(item.parts.map((p) => p.index));
    let cursor = 0;
    async function worker() {
      while (cursor < count) {
        const index = cursor++;
        if (done.has(index)) continue;
        if (!current(id, run)) throw abortError();
        const item = getItem(id)!,
          blob = item.file!.slice(
            index * size,
            Math.min(item.totalBytes, (index + 1) * size),
          );
        const sha256 = transport.capabilities.checksums
          ? await digest(blob)
          : "";
        const receipt = await retryOperation(
          id,
          run,
          "uploading",
          () =>
            request(id, run, (ctx) =>
              transport.upload(item.session!, {
                ...ctx,
                blob,
                index,
                sha256,
                onProgress(bytes) {
                  if (!current(id, run)) return;
                  run.inflight.set(
                    index,
                    Math.max(0, Math.min(blob.size, bytes)),
                  );
                  scheduleMetrics(id, run);
                },
              }),
            ),
          transport.capabilities.resume
            ? async () => {
                const remote = await probe(id, run);
                const receipt = remote.parts.find((p) => p.index === index);
                if (
                  receipt &&
                  (receipt.sha256 !== sha256 || receipt.size !== blob.size)
                )
                  throw new TransferError(
                    "Saved chunk does not match this file",
                    "FILE_MISMATCH",
                  );
                return { found: !!receipt, value: receipt };
              }
            : undefined,
        );
        if (
          receipt.index !== index ||
          receipt.size !== blob.size ||
          (transport.capabilities.checksums && receipt.sha256 !== sha256)
        )
          throw new TransferError(
            "Server returned an invalid part receipt",
            "CHECKPOINT",
          );
        run.inflight.delete(index);
        metrics(
          id,
          run,
          [
            ...getItem(id)!.parts.filter((p) => p.index !== index),
            receipt,
          ].sort((a, b) => a.index - b.index),
        );
      }
    }
    const tasks = Array.from(
      { length: Math.min(maxChunks, count - done.size) },
      worker,
    );
    // A failed worker stops peers. Await all before freeing file concurrency.
    try {
      await Promise.all(tasks);
    } catch (error) {
      run.controller.abort();
      await Promise.allSettled(tasks);
      throw error;
    }
    const result = await retryOperation(
      id,
      run,
      "finalizing",
      () =>
        request(id, run, (ctx) =>
          transport.complete(getItem(id)!.session!, ctx),
        ),
      transport.capabilities.resume
        ? async () => {
            const remote = await probe(id, run);
            return {
              found: remote.status === "completed",
              value: remote.result,
            };
          }
        : undefined,
    );
    finish(id, run, result);
  }
  function finish(id: string, run: Run, result: unknown) {
    if (!current(id, run)) return;
    const item = getItem(id)!;
    patch(
      id,
      {
        status: "completed",
        result,
        progress: 100,
        uploadedBytes: item.totalBytes,
        transferredBytes: item.totalBytes,
        remainingBytes: 0,
        bytesPerSecond: null,
        etaSeconds: null,
        error: undefined,
        nextRetryAt: null,
      },
      true,
    );
    try {
      void Promise.resolve(options.onCompleted?.(getItem(id)!)).catch((error) =>
        reportError(errorValue(error), getItem(id)),
      );
    } catch (error) {
      reportError(errorValue(error), getItem(id));
    }
  }
  function pump() {
    if (destroyed) return;
    while (active < maxFiles) {
      const item = state.items.find(
        (item) => item.status === "queued" && !runs.has(item.id),
      );
      if (!item) return;
      const run: Run = {
        generation: generations.get(item.id) ?? 0,
        controller: new AbortController(),
        started: Date.now(),
        initialActive: item.activeMilliseconds,
        inflight: new Map(),
        samples: [],
        lastNotice: 0,
        lastMetrics: 0,
      };
      runs.set(item.id, run);
      active++;
      const work = () => execute(item.id, run);
      const locks =
        typeof navigator !== "undefined" ? navigator.locks : undefined;
      // Session leases prevent two cooperating tabs from transmitting the same saved session.
      const task = locks
        ? locks.request(
            `salyra-upload:${item.requestKey}`,
            { signal: run.controller.signal },
            work,
          )
        : work();
      void task
        .catch((error) => {
          if (
            (generations.get(item.id) ?? 0) !== run.generation ||
            destroyed ||
            isAbort(error)
          )
            return;
          patch(
            item.id,
            {
              status:
                error instanceof TransferError &&
                (error.code === "EXPIRED" || error.status === 410)
                  ? "expired"
                  : "failed",
              error: errorValue(error),
              nextRetryAt: null,
              bytesPerSecond: null,
              etaSeconds: null,
            },
            true,
          );
          reportError(errorValue(error), getItem(item.id));
        })
        .finally(() => {
          clearTimeout(run.noticeTimer);
          clearTimeout(run.metricsTimer);
          if (runs.get(item.id) === run) runs.delete(item.id);
          active--;
          pump();
        });
    }
  }
  function stop(id: string, update?: Partial<UploadItem>, durable = false) {
    const run = runs.get(id);
    generations.set(id, (generations.get(id) ?? 0) + 1);
    validation.get(id)?.abort();
    validation.delete(id);
    if (run) {
      run.controller.abort();
      clearTimeout(run.noticeTimer);
      clearTimeout(run.metricsTimer);
    }
    if (run || update) {
      const item = getItem(id);
      if (!item) return;
      patch(
        id,
        {
          ...(run
            ? {
                activeMilliseconds:
                  run.initialActive + Date.now() - run.started,
                transferredBytes: item.uploadedBytes,
                progress: transport.capabilities.progress
                  ? item.totalBytes
                    ? (item.uploadedBytes / item.totalBytes) * 100
                    : 0
                  : null,
                bytesPerSecond: null,
                etaSeconds: null,
                nextRetryAt: null,
              }
            : {}),
          ...update,
        },
        durable,
      );
    }
  }
  async function cleanup(record: CleanupRecord) {
    const ctl = new AbortController();
    auxiliary.add(ctl);
    const timer = options.requestTimeout
      ? setTimeout(() => ctl.abort(), options.requestTimeout)
      : undefined;
    state = {
      ...state,
      cleanups: state.cleanups.map((c) =>
        c.id === record.id ? { ...c, status: "pending", error: undefined } : c,
      ),
    };
    notify();
    persist();
    try {
      const handler = options.onCancel ?? transport.terminate?.bind(transport);
      if (!handler)
        throw new TransferError(
          "Configure onCancel or a transport with termination to clean up this session",
          "CLEANUP_UNSUPPORTED",
        );
      let session = record.session;
      if (!session) {
        session = await pool.run(ctl.signal, () =>
          transport.create({
            signal: ctl.signal,
            metadata: record.metadata,
            requestKey: record.requestKey,
            chunkSize: record.chunkSize,
          }),
        );
        record = { ...record, session };
        state = {
          ...state,
          cleanups: state.cleanups.map((c) =>
            c.id === record.id ? record : c,
          ),
        };
        persist();
      }
      await pool.run(ctl.signal, () =>
        handler(session!, {
          signal: ctl.signal,
          metadata: record.metadata,
          requestKey: record.requestKey,
        }),
      );
      if (destroyed) return;
      state = {
        ...state,
        cleanups: state.cleanups.filter((c) => c.id !== record.id),
      };
    } catch (error) {
      if (destroyed) return;
      state = {
        ...state,
        cleanups: state.cleanups.map((c) =>
          c.id === record.id
            ? { ...c, status: "failed", error: errorValue(error) }
            : c,
        ),
      };
    } finally {
      clearTimeout(timer);
      auxiliary.delete(ctl);
      notify();
      persist();
    }
  }
  function scheduleCleanup(item: UploadItem) {
    // A plain HTTP transport has only a local request ID. Remote cleanup is application-owned.
    if (
      !transport.capabilities.resume &&
      !transport.capabilities.terminate &&
      !options.onCancel
    )
      return Promise.resolve();
    if (
      !item.session &&
      (!transport.capabilities.resume ||
        ["idle", "validating", "awaiting-file"].includes(item.status))
    )
      return Promise.resolve();
    const record: CleanupRecord = {
      id: uid(),
      itemId: item.id,
      session: item.session,
      requestKey: item.requestKey,
      chunkSize,
      metadata: item.metadata,
      status: "pending",
    };
    state = { ...state, cleanups: [...state.cleanups, record] };
    persist();
    return cleanup(record);
  }
  async function validateItem(
    id: string,
    file: File,
    ready: "idle" | "queued",
  ) {
    if (destroyed || getItem(id)?.status !== "validating") return;
    const ctl = new AbortController();
    validation.set(id, ctl);
    try {
      const fail = !accepts(file, options.accept)
        ? "File format is not accepted"
        : options.maxFileSize !== undefined && file.size > options.maxFileSize
          ? "File exceeds the size limit"
          : options.maxFiles !== undefined &&
              state.items.filter((i) => i.status !== "failed").length >
                options.maxFiles
            ? "File count exceeds the limit"
            : options.maxTotalSize !== undefined &&
                state.items
                  .filter((i) => i.status !== "failed")
                  .reduce((sum, i) => sum + i.totalBytes, 0) >
                  options.maxTotalSize
              ? "Total file size exceeds the limit"
              : await options.validateFile?.(file, ctl.signal);
      ctl.signal.throwIfAborted();
      if (destroyed || !getItem(id) || validation.get(id) !== ctl) return;
      if (fail) throw new TransferError(fail, "VALIDATION");
      validated.add(id);
      patch(id, { status: ready, error: undefined }, true);
      pump();
    } catch (error) {
      if (!isAbort(error) && !destroyed && validation.get(id) === ctl) {
        patch(id, { status: "failed", error: errorValue(error) }, true);
        reportError(errorValue(error), getItem(id));
      }
    } finally {
      if (validation.get(id) === ctl) validation.delete(id);
    }
  }
  const store: UploaderStore = {
    getSnapshot: () => state,
    getItem,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    subscribeItem(id, fn) {
      let set = itemListeners.get(id);
      if (!set) itemListeners.set(id, (set = new Set()));
      set.add(fn);
      return () => {
        set!.delete(fn);
        if (!set!.size) itemListeners.delete(id);
      };
    },
    async add(files) {
      assertAlive();
      if (options.persistence && !state.restored) await store.restore();
      if (!mutable()) return [];
      const ids: string[] = [];
      for (const file of files) {
        const id = uid(),
          item = {
            ...baseItem(id, metadataOf(file), file),
            status: "validating" as const,
          };
        collection([...state.items, item]);
        ids.push(id);
        await validateItem(id, file, options.autoUpload ? "queued" : "idle");
      }
      return ids;
    },
    addExisting(items) {
      assertAlive();
      const seen = new Set(state.items.map((item) => item.id));
      const fresh = items
        .filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        })
        .map((item) => ({
          ...baseItem(item.id, item.metadata),
          status: "completed" as const,
          result: item.result,
          uploadedBytes: item.metadata.size,
          transferredBytes: item.metadata.size,
          remainingBytes: 0,
          progress: 100,
        }));
      collection([...state.items, ...fresh]);
    },
    async loadHistory(cursor) {
      assertAlive();
      if (!options.loadHistory)
        throw new Error("Configure loadHistory to load remote records");
      const ctl = new AbortController();
      auxiliary.add(ctl);
      try {
        const page = await options.loadHistory(cursor, ctl.signal);
        if (!destroyed) store.addExisting(page.items);
        return page.nextCursor;
      } finally {
        auxiliary.delete(ctl);
      }
    },
    async restore() {
      assertAlive();
      if (restoreTask) return restoreTask;
      restoreTask = (async () => {
        try {
          const saved =
            options.persistence && (await options.persistence.load());
          if (destroyed) return;
          if (saved) {
            if (
              saved.version !== 1 ||
              !Array.isArray(saved.items) ||
              !Array.isArray(saved.cleanups)
            )
              throw new TransferError(
                "Invalid persistence snapshot",
                "PERSISTENCE",
              );
            const restored = saved.items
              .filter((item) => !getItem(item.id))
              .map((item) => ({
                ...item,
                file: undefined,
                status:
                  item.status === "completed" || item.status === "canceled"
                    ? item.status
                    : ("awaiting-file" as const),
                bytesPerSecond: null,
                etaSeconds: null,
                nextRetryAt: null,
                removing: false,
              }));
            state = {
              ...state,
              cleanups: [
                ...state.cleanups,
                ...saved.cleanups.map((c) => ({
                  ...c,
                  status: "failed" as const,
                })),
              ],
            };
            collection([...state.items, ...restored]);
          }
          state = { ...state, restored: true };
          notify();
          persist();
        } catch (error) {
          if (!destroyed) {
            state = {
              ...state,
              restored: true,
              persistenceError: errorValue(error),
            };
            notify();
          }
        }
      })();
      return restoreTask;
    },
    async attach(id, file) {
      assertAlive();
      if (!mutable()) return;
      const item = getItem(id);
      if (!item) throw new Error("Unknown upload");
      if (item.status === "completed")
        throw new TransferError("The upload is already completed", "COMPLETED");
      if (item.status === "expired")
        throw new TransferError(
          "Reset the expired transfer before selecting its file",
          "EXPIRED",
        );
      if (runs.has(id))
        throw new Error("Pause the transfer before replacing its file");
      if (file.name !== item.metadata.name || file.size !== item.totalBytes)
        throw new TransferError("Select the original file", "FILE_MISMATCH");
      // Content identity is verified against every server receipt during resume.
      validated.delete(id);
      stop(
        id,
        {
          file,
          status: item.status === "canceled" ? "canceled" : "paused",
          error: undefined,
        },
        true,
      );
    },
    start(id) {
      assertAlive();
      if (!mutable()) return;
      for (const item of state.items)
        if (
          (!id || item.id === id) &&
          item.file &&
          ["idle", "paused", "failed", "awaiting-file", "canceled"].includes(
            item.status,
          ) &&
          (!runs.has(item.id) ||
            runs.get(item.id)!.generation !==
              (generations.get(item.id) ?? 0)) &&
          item.error?.code !== "VALIDATION"
        ) {
          const needsValidation = !validated.has(item.id);
          const status = needsValidation ? "validating" : "queued";
          if (item.status === "canceled" || item.error?.code === "CANCELED") {
            // A canceled remote session cannot accept more parts. Keep cleanup on its old key.
            stop(
              item.id,
              {
                ...baseItem(item.id, item.metadata, item.file),
                status,
              },
              true,
            );
          } else {
            patch(item.id, { status, error: undefined }, true);
          }
          if (needsValidation) void validateItem(item.id, item.file, "queued");
        }
      pump();
    },
    pause(id) {
      if (!mutable()) return;
      const item = getItem(id);
      if (
        !item ||
        ![
          "uploading",
          "verifying",
          "retrying",
          "queued",
          "finalizing",
        ].includes(item.status)
      )
        return;
      stop(id, { status: "paused", error: undefined }, true);
    },
    resume(id) {
      store.start(id);
    },
    retry(id) {
      store.start(id);
    },
    async cancel(id) {
      if (!mutable()) return;
      const item = getItem(id);
      if (!item || ["completed", "canceled"].includes(item.status)) return;
      stop(
        id,
        {
          status: "canceled",
          error: undefined,
          nextRetryAt: null,
          bytesPerSecond: null,
          etaSeconds: null,
        },
        true,
      );
      await scheduleCleanup(item);
    },
    async reset(id) {
      if (!mutable()) return;
      const item = getItem(id);
      if (!item || item.status === "completed") return;
      stop(
        id,
        {
          ...baseItem(id, item.metadata, item.file),
          status: item.file ? "idle" : "awaiting-file",
        },
        true,
      );
      await scheduleCleanup(item);
    },
    async remove(id) {
      if (!mutable()) return;
      const item = getItem(id);
      if (!item || item.removing || item.status !== "completed") return;
      if (!options.onRemove) {
        patch(id, {
          removeError: {
            code: "REMOVE_UNSUPPORTED",
            message: "Configure onRemove to delete a completed file",
          },
        });
        return;
      }
      const ctl = new AbortController();
      auxiliary.add(ctl);
      patch(id, { removing: true, removeError: undefined });
      try {
        await options.onRemove(item, ctl.signal);
        if (!destroyed) {
          stop(id);
          validated.delete(id);
          collection(state.items.filter((current) => current.id !== id));
          itemListeners.get(id)?.forEach((fn) => fn());
        }
      } catch (error) {
        if (!destroyed)
          patch(id, { removing: false, removeError: errorValue(error) });
      } finally {
        auxiliary.delete(ctl);
      }
    },
    forget(id) {
      if (!mutable()) return;
      stop(id);
      validated.delete(id);
      collection(state.items.filter((item) => item.id !== id));
      itemListeners.get(id)?.forEach((fn) => fn());
    },
    async retryCleanup(id) {
      if (!mutable()) return;
      const record = state.cleanups.find((c) => c.id === id);
      if (record && record.status === "failed") await cleanup(record);
    },
    setOptions(next) {
      assertAlive();
      state = { ...state, ...next };
      notify();
    },
    destroy() {
      if (destroyed) return;
      for (const id of runs.keys()) stop(id);
      destroyed = true;
      validated.clear();
      validation.forEach((ctl) => ctl.abort());
      auxiliary.forEach((ctl) => ctl.abort());
      listeners.clear();
      itemListeners.clear();
    },
  };
  return store;
}
