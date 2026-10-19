import type { UploadError } from "./types";
export class TransferError extends Error {
  constructor(
    message: string,
    public code = "NETWORK",
    public status?: number,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = "TransferError";
  }
}
export const abortError = () =>
  new DOMException("The operation was stopped", "AbortError");
export const isAbort = (error: unknown) =>
  error instanceof Error && error.name === "AbortError";
export function errorValue(error: unknown): UploadError {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: error instanceof TransferError ? error.code : "UNKNOWN",
    ...(error instanceof TransferError && error.status
      ? { status: error.status }
      : {}),
  };
}
export function retryable(error: unknown): boolean {
  return (
    !isAbort(error) &&
    error instanceof TransferError &&
    (error.code === "NETWORK" ||
      error.code === "TIMEOUT" ||
      error.status === 408 ||
      error.status === 429 ||
      (error.status !== undefined &&
        [500, 502, 503, 504].includes(error.status)))
  );
}
export function retryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    function stop() {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(abortError());
    }
    signal.addEventListener("abort", stop, { once: true });
  });
}
/** Per-request permits include probe, create and finish, not just data requests. */
export class RequestPool {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private limit: number) {}
  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    while (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener("abort", stop);
          resolve();
        };
        const stop = () => {
          this.waiters = this.waiters.filter((w) => w !== ready);
          reject(abortError());
        };
        this.waiters.push(ready);
        signal.addEventListener("abort", stop, { once: true });
      });
      signal.throwIfAborted();
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
export async function digest(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
