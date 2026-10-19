import { TransferError, retryAfter } from "../core/errors";
import type { TransportContext, UploadSession } from "../core/types";
export type RequestOptions = {
  url:
    | string
    | ((
        context: TransportContext & { session?: UploadSession; index?: number },
      ) => string | Promise<string>);
  method?: string;
};
export interface HTTPOptions {
  headers?:
    | Record<string, string>
    | ((
        context: TransportContext,
      ) => Record<string, string> | Promise<Record<string, string>>);
  credentials?: RequestCredentials;
  fetch?: typeof globalThis.fetch;
}
export async function request(
  endpoint: RequestOptions,
  context: TransportContext & { session?: UploadSession; index?: number },
  options: HTTPOptions,
  body?: BodyInit,
  headers: Record<string, string> = {},
  onProgress?: (bytes: number) => void,
): Promise<unknown> {
  const url =
    typeof endpoint.url === "function"
      ? await endpoint.url(context)
      : endpoint.url;
  const authorization =
    typeof options.headers === "function"
      ? await options.headers(context)
      : options.headers;
  context.signal.throwIfAborted();
  const allHeaders = { ...authorization, ...headers };
  function decode(status: number, text: string, retry: string | null): unknown {
    let value: unknown;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      value = text;
    }
    if (status < 200 || status >= 300)
      throw new TransferError(
        typeof value === "object" && value && "message" in value
          ? String(value.message)
          : `Upload request failed (${status})`,
        status === 410
          ? "EXPIRED"
          : typeof value === "object" &&
              value &&
              "code" in value &&
              typeof value.code === "string"
            ? value.code
            : "HTTP",
        status,
        retryAfter(retry),
      );
    return value;
  }
  if (onProgress && typeof XMLHttpRequest !== "undefined" && !options.fetch) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const stop = () => xhr.abort();
      const clean = () => context.signal.removeEventListener("abort", stop);
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) onProgress(event.loaded);
      });
      xhr.open(endpoint.method ?? "GET", url);
      xhr.withCredentials = options.credentials === "include";
      for (const [key, value] of Object.entries(allHeaders))
        xhr.setRequestHeader(key, value);
      xhr.onload = () => {
        clean();
        try {
          resolve(
            decode(
              xhr.status,
              xhr.responseText,
              xhr.getResponseHeader("Retry-After"),
            ),
          );
        } catch (error) {
          reject(error);
        }
      };
      xhr.onerror = () => {
        clean();
        reject(
          new TransferError("Could not reach the upload server", "NETWORK"),
        );
      };
      xhr.onabort = () => {
        clean();
        reject(new DOMException("Request stopped", "AbortError"));
      };
      context.signal.addEventListener("abort", stop, { once: true });
      if (context.signal.aborted) {
        clean();
        reject(new DOMException("Request stopped", "AbortError"));
        return;
      }
      xhr.send(body as XMLHttpRequestBodyInit | null | undefined);
    });
  }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: endpoint.method ?? "GET",
      body,
      headers: allHeaders,
      credentials: options.credentials,
      signal: context.signal,
    });
  } catch (error) {
    if (context.signal.aborted) throw error;
    throw new TransferError("Could not reach the upload server", "NETWORK");
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (context.signal.aborted) throw error;
    throw new TransferError("Upload response was interrupted", "NETWORK");
  }
  const value = decode(
    response.status,
    text,
    response.headers.get("Retry-After"),
  );
  if (onProgress && body instanceof Blob) onProgress(body.size);
  return value;
}
