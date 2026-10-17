import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type {
  ServerOptions,
  ServerSession,
  StoredPart,
  UploadDescriptor,
  ServerOperation,
} from "./types";
import { UploadServerError } from "./types";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
const fail = (status: number, code: string, message: string): never => {
  throw new UploadServerError(status, code, message);
};
export function createUploadServer<Context = unknown>(
  options: ServerOptions<Context>,
) {
  const { sessionStore: sessions, storage } = options;
  if (!options.authorize && options.allowAnonymous !== true)
    throw new TypeError(
      "Provide authorize (and scope) from your authentication, or set allowAnonymous: true for a local demo",
    );
  for (const [name, value] of Object.entries({
    sessionTTL: options.sessionTTL,
    maxChunkSize: options.maxChunkSize,
    maxFileSize: options.maxFileSize,
  })) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < (name === "maxFileSize" ? 0 : 1))
    )
      throw new RangeError(`${name} has an invalid limit`);
  }
  if (
    ![
      storage.capabilities.minChunkSize,
      storage.capabilities.maxChunkSize,
      storage.capabilities.maxParts,
    ].every((value) => Number.isSafeInteger(value) && value > 0) ||
    storage.capabilities.minChunkSize > storage.capabilities.maxChunkSize
  )
    throw new RangeError("Storage capabilities have invalid limits");
  const notifications = new AsyncLocalStorage<Array<() => Promise<void>>>();
  async function transaction<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (notifications.getStore()) return sessions.transaction(key, operation);
    const pending: Array<() => Promise<void>> = [];
    try {
      return await notifications.run(pending, () =>
        sessions.transaction(key, operation),
      );
    } finally {
      // Application observers run after storage locks have been released.
      for (const deliver of pending) await deliver();
    }
  }
  async function event(
    type: "created" | "part-stored" | "completed" | "canceled" | "expired",
    session: ServerSession,
    context: Context | undefined,
    part?: StoredPart,
  ) {
    const pending = notifications.getStore();
    if (pending) {
      const snapshot = {
        ...session,
        descriptor: { ...session.descriptor },
        parts: session.parts.map((part) => ({ ...part })),
      };
      pending.push(() => event(type, snapshot, context, part && { ...part }));
      return;
    }
    // Notifications never turn a committed transfer into a failed request. Event IDs are stable for application outboxes.
    try {
      await options.onEvent?.(
        {
          id: `${session.id}:${type}${part ? `:${part.index}` : ""}`,
          type,
          session,
          part,
        },
        context,
      );
    } catch (error) {
      try {
        options.onNotificationError?.(error);
      } catch {}
    }
  }
  async function session(
    id: string,
    operation: ServerOperation,
    context: Context | undefined,
  ) {
    const value = await sessions.get(id);
    if (!value) return fail(404, "NOT_FOUND", "Upload session was not found");
    await options.authorize?.(operation, value, context);
    if (value.state === "expired")
      return fail(410, "EXPIRED", "Upload session expired");
    if (
      value.expiresAt <= Date.now() &&
      value.state !== "completed" &&
      value.state !== "canceled"
    ) {
      if (value.state === "finalizing") {
        const completed = await storage.inspectResult(value, context);
        if (completed.found) {
          value.state = "completed";
          value.result = completed.result;
          await sessions.put(value);
          await event("completed", value, context);
          return value;
        }
      }
      await storage.abort(value, context);
      value.state = "expired";
      await sessions.put(value);
      await event("expired", value, context);
      return fail(410, "EXPIRED", "Upload session expired");
    }
    return value;
  }
  async function reconcile(value: ServerSession, context: Context | undefined) {
    if (value.state === "completed" || value.state === "canceled") return value;
    const result = await storage.inspectResult(value, context);
    if (result.found) {
      value.state = "completed";
      value.result = result.result;
      await sessions.put(value);
      await event("completed", value, context);
      return value;
    }
    const parts = await storage.probe(value, context);
    const count = Math.max(
        1,
        Math.ceil(value.descriptor.size / value.descriptor.chunkSize),
      ),
      seen = new Set<number>();
    const confirmed = new Map(value.parts.map((part) => [part.index, part]));
    for (const part of parts) {
      if (
        !Number.isSafeInteger(part.index) ||
        part.index < 0 ||
        part.index >= count ||
        seen.has(part.index) ||
        part.size !==
          Math.min(
            value.descriptor.chunkSize,
            value.descriptor.size - part.index * value.descriptor.chunkSize,
          ) ||
        !/^[a-f0-9]{64}$/.test(part.sha256)
      )
        return fail(
          500,
          "STORAGE_CHECKPOINT",
          "Storage returned an invalid chunk",
        );
      seen.add(part.index);
      const old = confirmed.get(part.index);
      if (old && (old.sha256 !== part.sha256 || old.size !== part.size))
        return fail(
          409,
          "STORAGE_CONFLICT",
          "Stored chunk changed after confirmation",
        );
    }
    value.parts = parts.sort((a, b) => a.index - b.index);
    await sessions.put(value);
    return value;
  }
  return {
    capabilities: { protocol: "salyra-upload/1", ...storage.capabilities },
    async createUpload(
      descriptor: UploadDescriptor,
      key: string,
      context?: Context,
    ) {
      await options.authorize?.("create", undefined, context);
      if (
        !descriptor ||
        descriptor.protocol !== "salyra-upload/1" ||
        typeof descriptor.name !== "string" ||
        [...descriptor.name].length > 1024 ||
        typeof descriptor.type !== "string" ||
        !Number.isSafeInteger(descriptor.size) ||
        descriptor.size < 0 ||
        !Number.isSafeInteger(descriptor.lastModified) ||
        descriptor.lastModified < 0 ||
        !Number.isSafeInteger(descriptor.chunkSize) ||
        descriptor.chunkSize < storage.capabilities.minChunkSize ||
        descriptor.chunkSize >
          Math.min(
            storage.capabilities.maxChunkSize,
            options.maxChunkSize ?? Infinity,
          )
      )
        return fail(400, "DESCRIPTOR", "Invalid upload configuration");
      if (
        descriptor.size > (options.maxFileSize ?? Infinity) ||
        Math.max(1, Math.ceil(descriptor.size / descriptor.chunkSize)) >
          storage.capabilities.maxParts
      )
        return fail(413, "FILE_SIZE", "File exceeds the configured limits");
      if (!key || key.length > 200)
        return fail(400, "IDEMPOTENCY_KEY", "An idempotency key is required");
      await options.validateUpload?.(descriptor, context);
      const scope = (await options.scope?.(context)) ?? "",
        scopedKey = createHash("sha256")
          .update(JSON.stringify([scope, key]))
          .digest("hex");
      return transaction(`create:${scopedKey}`, async () => {
        const existing = await sessions.get(scopedKey);
        if (existing) {
          return transaction(existing.id, async () => {
            const current = await sessions.get(existing.id);
            if (!current)
              return fail(404, "NOT_FOUND", "Upload session was not found");
            await options.authorize?.("create", current, context);
            if (canonical(current.descriptor) !== canonical(descriptor))
              return fail(
                409,
                "KEY_CONFLICT",
                "This idempotency key belongs to another file",
              );
            if (
              current.state === "finalizing" &&
              current.expiresAt <= Date.now()
            )
              await reconcile(current, context);
            if (
              current.state === "expired" ||
              (current.expiresAt <= Date.now() && current.state !== "completed")
            )
              return fail(410, "EXPIRED", "Upload session expired");
            return {
              id: current.id,
              chunkSize: current.descriptor.chunkSize,
              expiresAt: current.expiresAt,
            };
          });
        }
        const value: ServerSession = {
          id: scopedKey,
          key: scopedKey,
          descriptor,
          expiresAt: Date.now() + (options.sessionTTL ?? 24 * 60 * 60 * 1000),
          state: "open",
          storageRef: undefined,
          parts: [],
        };
        value.storageRef = await storage.begin(value, context);
        await sessions.put(value);
        await event("created", value, context);
        return {
          id: value.id,
          chunkSize: descriptor.chunkSize,
          expiresAt: value.expiresAt,
        };
      });
    },
    async getUpload(id: string, context?: Context) {
      return transaction(id, async () => {
        const value = await reconcile(
          await session(id, "probe", context),
          context,
        );
        return {
          status: value.state,
          parts: value.parts.map(({ reference, ...part }) => part),
          expiresAt: value.expiresAt,
          ...(value.state === "completed" ? { result: value.result } : {}),
        };
      });
    },
    async receivePart(
      id: string,
      index: number,
      sha256: string,
      body: Readable,
      context?: Context,
    ) {
      return transaction(id, async () => {
        let value = await session(id, "part", context);
        if (value.state === "finalizing")
          value = await reconcile(value, context);
        if (value.state !== "open")
          return fail(409, "STATE", "This upload does not accept chunks");
        const count = Math.max(
          1,
          Math.ceil(value.descriptor.size / value.descriptor.chunkSize),
        );
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= count ||
          !/^[a-f0-9]{64}$/.test(sha256)
        )
          return fail(400, "PART", "Invalid chunk number or checksum");
        const size = Math.min(
          value.descriptor.chunkSize,
          value.descriptor.size - index * value.descriptor.chunkSize,
        );
        const existing = value.parts.find((part) => part.index === index);
        if (existing) {
          // Consume and validate the retransmitted body. A matching header does not prove matching content.
          const hash = createHash("sha256");
          let actual = 0;
          for await (const chunk of body) {
            actual += chunk.length;
            if (actual > size)
              return fail(413, "PART_SIZE", "Chunk exceeds its expected size");
            hash.update(chunk);
          }
          if (
            actual !== size ||
            hash.digest("hex") !== existing.sha256 ||
            sha256 !== existing.sha256
          )
            return fail(
              409,
              "PART_CONFLICT",
              "This chunk number already contains different data",
            );
          const { reference, ...receipt } = existing;
          return receipt;
        }
        const part = await storage.writePart(
          value,
          { index, size, sha256 },
          body,
          context,
        );
        if (
          part.index !== index ||
          part.size !== size ||
          part.sha256 !== sha256
        )
          return fail(
            500,
            "STORAGE_RECEIPT",
            "Storage returned an invalid receipt",
          );
        value.parts.push(part);
        value.parts.sort((a, b) => a.index - b.index);
        await sessions.put(value);
        await event("part-stored", value, context, part);
        const { reference, ...receipt } = part;
        return receipt;
      });
    },
    async finishUpload(id: string, context?: Context) {
      return transaction(id, async () => {
        const value = await reconcile(
          await session(id, "complete", context),
          context,
        );
        if (value.state === "completed") return value.result;
        if (value.state === "canceled")
          return fail(409, "CANCELED", "Upload was canceled");
        const count = Math.max(
          1,
          Math.ceil(value.descriptor.size / value.descriptor.chunkSize),
        );
        if (
          value.parts.length !== count ||
          value.parts.some((part, index) => part.index !== index)
        )
          return fail(409, "INCOMPLETE", "Upload is missing chunks");
        value.state = "finalizing";
        await sessions.put(value);
        try {
          value.result = await storage.finish(value, value.parts, context);
        } catch (error) {
          const completed = await storage.inspectResult(value, context);
          if (!completed.found) throw error;
          value.result = completed.result;
        }
        value.state = "completed";
        await sessions.put(value);
        await event("completed", value, context);
        return value.result;
      });
    },
    async cancelUpload(id: string, context?: Context) {
      return transaction(id, async () => {
        const value = await reconcile(
          await session(id, "cancel", context),
          context,
        );
        if (value.state === "completed")
          return fail(
            409,
            "COMPLETED",
            "Use the application removal callback to delete a completed file",
          );
        // A failed abort is retried while retaining the session reference.
        await storage.abort(value, context);
        value.state = "canceled";
        value.parts = [];
        await sessions.put(value);
        await event("canceled", value, context);
      });
    },
    async sweepExpired(context?: Context) {
      for await (const value of sessions.list())
        if (
          value.expiresAt <= Date.now() &&
          !["completed", "canceled", "expired"].includes(value.state)
        ) {
          await transaction(value.id, async () => {
            const current = await sessions.get(value.id);
            if (
              current &&
              current.expiresAt <= Date.now() &&
              !["completed", "canceled", "expired"].includes(current.state)
            ) {
              if (current.state === "finalizing") {
                const recovered = await reconcile(current, context);
                if (recovered.state === "completed") return;
              }
              await storage.abort(current, context);
              current.state = "expired";
              await sessions.put(current);
              await event("expired", current, context);
            }
          });
        }
    },
  };
}
export type UploadServer<Context = unknown> = ReturnType<
  typeof createUploadServer<Context>
>;
