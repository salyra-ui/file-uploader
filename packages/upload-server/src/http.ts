import type { IncomingMessage, ServerResponse } from "node:http";
import type { UploadServer } from "./engine";
import { UploadServerError, type UploadDescriptor } from "./types";
export interface RouteMatch {
  operation: "create" | "probe" | "part" | "complete" | "cancel";
  id?: string;
  index?: number;
}
export interface HandlerOptions<Context = unknown> {
  context?(request: IncomingMessage): Context | Promise<Context>;
  maxJSONBytes?: number;
  match?(request: IncomingMessage): RouteMatch | undefined;
  basePath?: string;
}
/** The application may call one operation handler from its own route. Nothing is registered on import. */
export function createUploadHandlers<Context = unknown>(
  server: UploadServer<Context>,
  options: HandlerOptions<Context> = {},
) {
  async function json(request: IncomingMessage) {
    // A cross-site form can post text/plain without a CORS preflight; it cannot send this type.
    const type = String(request.headers["content-type"] ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (type !== "application/json")
      throw new UploadServerError(
        415,
        "CONTENT_TYPE",
        "Upload metadata must be sent as application/json",
      );
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > (options.maxJSONBytes ?? 65536))
        throw new UploadServerError(
          413,
          "JSON_SIZE",
          "Upload metadata is too large",
        );
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString()) as UploadDescriptor;
    } catch {
      throw new UploadServerError(400, "JSON", "Invalid JSON body");
    }
  }
  return {
    create: async (request: IncomingMessage) =>
      server.createUpload(
        await json(request),
        String(request.headers["idempotency-key"] ?? ""),
        await options.context?.(request),
      ),
    probe: async (request: IncomingMessage, id: string) =>
      server.getUpload(id, await options.context?.(request)),
    part: async (request: IncomingMessage, id: string, index: number) =>
      server.receivePart(
        id,
        index,
        String(request.headers["upload-checksum"] ?? ""),
        request,
        await options.context?.(request),
      ),
    complete: async (request: IncomingMessage, id: string) =>
      server.finishUpload(id, await options.context?.(request)),
    cancel: async (request: IncomingMessage, id: string) =>
      server.cancelUpload(id, await options.context?.(request)),
  };
}
export function createUploadRouter<Context = unknown>(
  server: UploadServer<Context>,
  options: HandlerOptions<Context> = {},
) {
  const handlers = createUploadHandlers(server, options),
    base = (options.basePath ?? "/uploads").replace(/\/$/, "");
  const defaultMatch = (request: IncomingMessage): RouteMatch | undefined => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === base && request.method === "POST")
      return { operation: "create" };
    if (!path.startsWith(`${base}/`)) return;
    const rest = path.slice(base.length + 1).split("/");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(rest[0])) return;
    if (rest.length === 1 && request.method === "GET")
      return { operation: "probe", id: rest[0] };
    if (rest.length === 1 && request.method === "DELETE")
      return { operation: "cancel", id: rest[0] };
    if (
      rest.length === 2 &&
      rest[1] === "complete" &&
      request.method === "POST"
    )
      return { operation: "complete", id: rest[0] };
    if (
      rest.length === 3 &&
      rest[1] === "parts" &&
      /^\d+$/.test(rest[2]) &&
      request.method === "PUT"
    )
      return { operation: "part", id: rest[0], index: Number(rest[2]) };
  };
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    const match = (options.match ?? defaultMatch)(request);
    if (!match) return false;
    try {
      let result: unknown;
      switch (match.operation) {
        case "create":
          result = await handlers.create(request);
          break;
        case "probe":
          result = await handlers.probe(request, match.id!);
          break;
        case "part":
          result = await handlers.part(request, match.id!, match.index!);
          break;
        case "complete":
          result = await handlers.complete(request, match.id!);
          break;
        case "cancel":
          await handlers.cancel(request, match.id!);
          result = null;
          break;
      }
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(
        error instanceof UploadServerError ? error.status : 500,
        { "Content-Type": "application/json", "Cache-Control": "no-store" },
      );
      response.end(
        JSON.stringify({
          code: error instanceof UploadServerError ? error.code : "INTERNAL",
          message:
            error instanceof UploadServerError
              ? error.message
              : "Upload operation failed",
        }),
      );
    }
    return true;
  };
}
