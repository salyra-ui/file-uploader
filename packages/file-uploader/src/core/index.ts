export * from "./types";
export { createUploader } from "./store";
export { indexedDBPersistence } from "./persistence";
export { TransferError, retryAfter } from "./errors";
export function formatBytes(
  bytes: number,
  options: {
    locale?: string;
    base?: 1000 | 1024;
    maximumFractionDigits?: number;
  } = {},
) {
  const base = options.base ?? 1024,
    units =
      base === 1024
        ? ["B", "KiB", "MiB", "GiB", "TiB"]
        : ["B", "kB", "MB", "GB", "TB"];
  const exponent =
    bytes <= 0
      ? 0
      : Math.min(
          units.length - 1,
          Math.floor(Math.log(bytes) / Math.log(base)),
        );
  return `${new Intl.NumberFormat(options.locale, { maximumFractionDigits: options.maximumFractionDigits ?? 1 }).format(bytes / base ** exponent)} ${units[exponent]}`;
}

/** Available actions from one item. Root disabled/readOnly flags also apply to the controls. */
export function uploadActions(item: import("./types").UploadItem) {
  return {
    canStart:
      !!item.file &&
      ["idle", "paused", "failed", "awaiting-file", "canceled"].includes(
        item.status,
      ) &&
      item.error?.code !== "VALIDATION",
    canPause: [
      "queued",
      "verifying",
      "uploading",
      "retrying",
      "finalizing",
    ].includes(item.status),
    canResume: !!item.file && ["paused", "awaiting-file"].includes(item.status),
    canRetry:
      !!item.file &&
      ["failed", "canceled"].includes(item.status) &&
      item.error?.code !== "VALIDATION",
    canCancel: !["completed", "canceled"].includes(item.status),
    canReset: item.status !== "completed",
    canRemove: item.status === "completed" && !item.removing,
    canForget: true,
  };
}
