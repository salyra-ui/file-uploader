import type {
  Checkpoint,
  PartReceipt,
  UploadSession,
  UploadTransport,
} from "../core/types";
import { request, type HTTPOptions, type RequestOptions } from "./request";
export interface ChunkedOptions extends HTTPOptions {
  baseURL?: string;
  routes?: Partial<
    Record<
      "create" | "probe" | "upload" | "complete" | "terminate",
      RequestOptions
    >
  >;
}
export function chunkedTransport(options: ChunkedOptions): UploadTransport {
  const base = (options.baseURL ?? "/uploads").replace(/\/$/, "");
  const routes: Record<string, RequestOptions> = {
    create: { url: base, method: "POST" },
    probe: {
      url: (ctx) => `${base}/${encodeURIComponent(ctx.session!.id)}`,
      method: "GET",
    },
    upload: {
      url: (ctx) =>
        `${base}/${encodeURIComponent(ctx.session!.id)}/parts/${ctx.index}`,
      method: "PUT",
    },
    complete: {
      url: (ctx) => `${base}/${encodeURIComponent(ctx.session!.id)}/complete`,
      method: "POST",
    },
    terminate: {
      url: (ctx) => `${base}/${encodeURIComponent(ctx.session!.id)}`,
      method: "DELETE",
    },
    ...options.routes,
  };
  return {
    capabilities: {
      resume: true,
      progress: true,
      parallelParts: true,
      checksums: true,
      terminate: true,
    },
    async create(ctx) {
      return (await request(
        routes.create,
        ctx,
        options,
        JSON.stringify({
          protocol: "salyra-upload/1",
          ...ctx.metadata,
          chunkSize: ctx.chunkSize,
        }),
        {
          "Content-Type": "application/json",
          "Idempotency-Key": ctx.requestKey,
        },
      )) as UploadSession;
    },
    async probe(session, ctx) {
      return (await request(
        routes.probe,
        { ...ctx, session },
        options,
      )) as Checkpoint;
    },
    async upload(session, ctx) {
      return (await request(
        routes.upload,
        { ...ctx, session },
        options,
        ctx.blob,
        {
          "Content-Type": "application/octet-stream",
          "Upload-Checksum": ctx.sha256,
        },
        ctx.onProgress,
      )) as PartReceipt;
    },
    async complete(session, ctx) {
      return (await request(
        routes.complete,
        { ...ctx, session },
        options,
      )) as unknown;
    },
    async terminate(session, ctx) {
      await request(routes.terminate, { ...ctx, session }, options);
    },
  };
}
