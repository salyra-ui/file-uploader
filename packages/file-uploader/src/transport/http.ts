import type {
  PartReceipt,
  UploadTransport,
  TransportContext,
  UploadSession,
} from "../core/types";
import { request, type HTTPOptions, type RequestOptions } from "./request";
/** Single-request uploads retry the entire file. The server must honor the request key if duplicate uploads matter. */
export function httpTransport(
  options: HTTPOptions &
    RequestOptions & {
      formField?: string;
      progress?: boolean;
      parseResponse?(
        value: unknown,
        context: TransportContext,
      ): unknown | Promise<unknown>;
    },
): UploadTransport {
  const results = new WeakMap<UploadSession, unknown>();
  return {
    capabilities: {
      resume: false,
      progress: options.progress ?? !options.fetch,
      parallelParts: false,
      checksums: false,
      terminate: false,
    },
    async create(ctx) {
      return { id: ctx.requestKey, chunkSize: Math.max(1, ctx.metadata.size) };
    },
    async probe() {
      throw new Error("Single-request uploads do not support resume");
    },
    async upload(session, ctx): Promise<PartReceipt> {
      let body: Blob | FormData = ctx.blob;
      if (options.formField) {
        body = new FormData();
        body.append(options.formField, ctx.blob, ctx.metadata.name);
      }
      const value = await request(
        { url: options.url, method: options.method ?? "POST" },
        { ...ctx, session },
        options,
        body,
        { "Idempotency-Key": ctx.requestKey },
        (bytes) => ctx.onProgress(Math.min(ctx.blob.size, bytes)),
      );
      const parsed = options.parseResponse
        ? await options.parseResponse(value, ctx)
        : value;
      ctx.signal.throwIfAborted();
      results.set(session, parsed);
      return { index: 0, size: ctx.blob.size, sha256: "" };
    },
    async complete(session) {
      const value = results.get(session);
      results.delete(session);
      return value;
    },
  };
}
