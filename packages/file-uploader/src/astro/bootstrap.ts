import { mountUploader } from "../vanilla";
import { chunkedTransport } from "../transport/chunked";
import { httpTransport } from "../transport/http";
import { formatBytes } from "../core";
import type { UploaderOptions } from "../core";
export type UploadBootstrap = Pick<
  UploaderOptions,
  | "autoUpload"
  | "chunkSize"
  | "maxConcurrentFiles"
  | "maxConcurrentChunks"
  | "maxConcurrentRequests"
  | "retry"
  | "accept"
  | "maxFileSize"
  | "maxTotalSize"
  | "maxFiles"
  | "disabled"
  | "readOnly"
  | "initialFiles"
> & {
  endpoint: string;
  transport?: "chunked" | "http";
  formField?: string;
  progress?: boolean;
};
/** Rich callbacks are configured by mounting Vanilla in a client script instead of serializing functions. */
export function connectUploader(root: HTMLElement) {
  const config = JSON.parse(
    root.querySelector<HTMLScriptElement>(":scope > [data-upload-options]")!
      .textContent!,
  ) as UploadBootstrap;
  const { endpoint, transport: kind, formField, progress, ...options } = config;
  const mounted = mountUploader(
    root,
    {
      ...options,
      transport:
        kind === "http"
          ? httpTransport({ url: endpoint, formField, progress })
          : chunkedTransport({ baseURL: endpoint }),
    },
    {
      renderMetadata: (item) => formatBytes(item.totalBytes),
      renderProgress(element, item) {
        element.style.setProperty(
          "--upload-progress",
          `${item.progress ?? 0}%`,
        );
        element.setAttribute("data-state", item.status);
        element.toggleAttribute("data-indeterminate", item.progress === null);
        const text = element.querySelector("[data-upload-percentage]");
        if (text)
          text.textContent =
            item.progress === null ? "" : `${Math.round(item.progress)}%`;
      },
      renderItem() {
        const template = root.querySelector<HTMLTemplateElement>(
          "[data-upload-template]",
        );
        const element = template?.content.firstElementChild?.cloneNode(true) as
          HTMLElement | undefined;
        if (!element)
          throw new Error(
            "Add a template with data-upload-template containing the markup for one item",
          );
        return element;
      },
    },
  );
  return () => mounted.destroy();
}
