import "./styles.css";
import {
  createUploader,
  indexedDBPersistence,
  formatBytes,
  type UploadItem,
  type UploaderStore,
} from "../packages/file-uploader/src/core";
import { chunkedTransport } from "../packages/file-uploader/src/transport/chunked";
import { httpTransport } from "../packages/file-uploader/src/transport/http";
import { mountUploader } from "../packages/file-uploader/src/vanilla";
import { languages, snippet } from "./snippets";
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (value) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        value
      ]!,
  );
const examples = [
  {
    id: "http",
    title: "One file, one request",
    description:
      "Send a file to one endpoint. This example uses a raw body and an application-defined response. A retry starts from the beginning.",
  },

  {
    id: "chunked",
    title: "A queue you can control",
    description:
      "Select files, start the queue and pause individual transfers. Chunks are confirmed by the server before they count as saved.",
  },
  {
    id: "resume",
    title: "Pick up after a refresh",
    description:
      "Upload part of a file, pause it and reload this page. Select the original file again to continue. Every saved chunk is checked before it is reused.",
  },
  {
    id: "retry",
    title: "Try a failed request",
    description:
      "Reject one request with the test button. Watch the retry countdown, or cancel while it waits. This example uses a deliberate server error.",
  },
  {
    id: "parallel",
    title: "Independent chunks",
    description:
      "Send up to three chunks per file, with a shared limit of four requests. Saved chunks appear in the strip below each transfer.",
  },
  {
    id: "indeterminate",
    title: "Progress without a percentage",
    description:
      "Some transports cannot measure upload progress. Show a transfer state while the request runs, then the confirmed result.",
  },
  {
    id: "gallery",
    title: "Choose your own preview",
    description:
      "Images use a thumbnail. Other formats show their MIME type. The renderer, classes and controls belong to the example.",
  },
  {
    id: "limits",
    title: "Selection rules and disabled states",
    description:
      "This example accepts images up to 2 MiB, with a limit of three files. Disabled and read-only states block interaction without canceling an active transfer.",
  },
];
document.querySelector("#app")!.innerHTML =
  `<header><a class="brand" href="https://salyra-ui.github.io/docs/">salyra<span>/ui</span></a><nav><a href="https://salyra-ui.github.io/docs/components.html">Components</a><a href="https://github.com/salyra-ui">GitHub</a></nav></header><main><div class="intro"><div><span class="eyebrow">File Uploader</span><h1>Your files.<br>Your interface.</h1></div><div><p>Compose an upload area, a file list or a gallery. Use the same transfer engine behind each one.</p><code>npm install @salyra-ui/file-uploader</code><p class="notice">These examples send files to the local reference server. Chunks are delayed by 120 ms so the transfer states are visible.</p></div></div><div class="docs-layout"><aside class="sidebar">${examples.map((example) => `<a href="#${example.id}">${example.title}</a>`).join("")}<a href="#history">Uploaded files</a></aside><div>${examples.map((example) => `<section class="example" id="${example.id}"><h2>${example.title}</h2><p>${example.description}</p><div class="toolbar"><div class="view-tabs" role="tablist" aria-label="${example.title}"><button type="button" role="tab" data-tab="preview" aria-selected="true">Preview</button><button type="button" role="tab" data-tab="code" aria-selected="false">Code</button></div><button type="button" class="copy" data-copy>Copy code</button></div><div class="example-body ${example.id === "gallery" ? "gallery" : ""}" data-panel="preview"><div class="settings"></div><div class="dropzone" data-upload-dropzone><h3>Drop your files here</h3><p>${example.id === "limits" ? "Images only, up to 2 MiB each" : "Or choose them from your device"}</p><input class="sr-only" type="file" multiple data-upload-input aria-label="Select files"/><button class="primary" type="button" data-upload-trigger>Select files</button></div><div class="actions"><button type="button" data-upload-start>Upload files</button>${example.id === "retry" ? '<button type="button" data-fail>Reject next request</button>' : ""}</div><div class="empty">No files selected.</div><ul class="file-list" data-upload-list></ul><div class="cleanups" aria-live="polite"></div><p class="error" data-error aria-live="polite"></p></div><div class="code-panel" data-panel="code" hidden><div class="languages" role="tablist" aria-label="Code language">${languages.map((language, i) => `<button type="button" role="tab" data-language="${language}" aria-selected="${i === 0}">${language}</button>`).join("")}</div><pre><code></code></pre></div></section>`).join("")}<section id="history" class="example"><h2>Uploaded files</h2><p>Load files already stored on the server. Removal is an application callback, with its own error state.</p><div class="toolbar"><div class="view-tabs" role="tablist" aria-label="Uploaded files"><button type="button" role="tab" data-tab="preview" aria-selected="true">Preview</button><button type="button" role="tab" data-tab="code" aria-selected="false">Code</button></div><button type="button" class="copy" data-copy>Copy code</button></div><div data-panel="preview" class="example-body"><button type="button" data-refresh>Load uploaded files</button><button type="button" data-fail-remove>Reject next removal</button><div class="history-grid" data-upload-list></div><p data-history-error class="error" aria-live="polite"></p><p class="notice">The reference server stores files in this project's .uploads directory.</p></div><div class="code-panel" data-panel="code" hidden><div class="languages" role="tablist" aria-label="History code language">${languages.map((language, i) => `<button type="button" role="tab" data-language="${language}" aria-selected="${i === 0}">${language}</button>`).join("")}</div><pre><code></code></pre></div></section></div></div></main><footer>Salyra UI · File Uploader</footer>`;
const owned: Array<() => void> = [];
const stores = new Map<string, UploaderStore>();
// One tab stop per group. Arrow keys choose and activate the neighboring tab.
document.querySelectorAll<HTMLElement>('[role="tablist"]').forEach((group) => {
  const tabs = Array.from(
    group.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
  const updateFocus = (active: HTMLButtonElement) => {
    for (const tab of tabs) tab.tabIndex = tab === active ? 0 : -1;
  };
  for (const tab of tabs) {
    tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
    tab.addEventListener("click", () => updateFocus(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.defaultPrevented) return;
      const index = tabs.indexOf(tab);
      const next =
        event.key === "ArrowRight"
          ? (index + 1) % tabs.length
          : event.key === "ArrowLeft"
            ? (index - 1 + tabs.length) % tabs.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : -1;
      if (next === -1) return;
      event.preventDefault();
      tabs[next].focus();
      tabs[next].click();
    });
  }
});
function row(item: UploadItem, store: UploaderStore) {
  const element = document.createElement("li");
  element.className = "file-row";
  element.innerHTML = `<div class="file-details"><span class="file-name" data-upload-name></span><span class="file-meta" data-upload-metadata></span><span class="file-status" data-upload-status aria-live="polite"></span><span class="retry-countdown" data-retry-countdown></span><div data-upload-preview></div><span class="error" data-item-error></span></div><div class="file-actions">${["start", "pause", "resume", "retry", "cancel", "reset", "remove", "forget"].map((action) => `<button type="button" data-upload-action="${action}">${action === "start" ? "Upload" : action.charAt(0).toUpperCase() + action.slice(1)}</button>`).join("")}<button type="button" data-select-original>Select original</button><input type="file" data-original class="sr-only" aria-label="Select the original file"/></div><div class="progress-block" data-upload-progress aria-label="Upload progress"><div class="progress-track"><div class="progress-fill"></div></div><div class="progress-values"><span data-percentage></span><span data-metrics></span></div><div class="part-strip"></div></div>`;
  const reselect = element.querySelector<HTMLInputElement>("[data-original]")!;
  element
    .querySelector("[data-select-original]")!
    .addEventListener("click", () => reselect.click());
  reselect.addEventListener("change", () => {
    const file = reselect.files?.[0];
    if (file)
      void store
        .attach(item.id, file)
        .then(() => store.resume(item.id))
        .catch(
          (error) =>
            (element.querySelector("[data-item-error]")!.textContent =
              error.message),
        );
    reselect.value = "";
  });
  return element;
}
for (const example of examples) {
  const section = document.getElementById(example.id)!,
    root = section.querySelector<HTMLElement>(".example-body")!;
  let language = "React";
  const code = section.querySelector("pre code")!;
  const updateCode = () => (code.textContent = snippet(language, example.id));
  updateCode();
  section.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) =>
    button.addEventListener("click", () => {
      section
        .querySelectorAll("[data-tab]")
        .forEach((tab) =>
          tab.setAttribute("aria-selected", String(tab === button)),
        );
      section
        .querySelectorAll<HTMLElement>("[data-panel]")
        .forEach(
          (panel) =>
            (panel.hidden = panel.dataset.panel !== button.dataset.tab),
        );
    }),
  );
  section
    .querySelectorAll<HTMLButtonElement>("[data-language]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        language = button.dataset.language!;
        section
          .querySelectorAll("[data-language]")
          .forEach((tab) =>
            tab.setAttribute("aria-selected", String(tab === button)),
          );
        updateCode();
      }),
    );
  section
    .querySelector("[data-copy]")!
    .addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      await navigator.clipboard.writeText(code.textContent!);
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy code"), 1500);
    });
  const store = createUploader({
    transport: /* docs-transport-start */ ["http", "indeterminate"].includes(
      example.id,
    )
      ? httpTransport({
          url: "/demo/http",
          progress: example.id !== "indeterminate",
          headers: ({ metadata }) => ({
            "X-File-Name": encodeURIComponent(metadata.name),
            "X-File-Type": metadata.type,
            "X-File-Modified": String(metadata.lastModified),
          }),
        })
      : chunkedTransport({
          baseURL: "/uploads",
          headers: { "X-Demo-Example": example.id },
        }) /* docs-transport-end */,
    chunkSize: 256 * 1024,
    maxConcurrentChunks: example.id === "parallel" ? 3 : 1,
    retry: { maxAttempts: 4, baseDelay: 1000 },
    persistence:
      example.id === "resume"
        ? indexedDBPersistence("salyra-local-example:resume")
        : false,
    ...(example.id === "limits"
      ? { accept: "image/*", maxFileSize: 2 * 1024 * 1024, maxFiles: 3 }
      : {}),
    onRemove: async (item) => {
      const result = item.result as { id: string };
      const response = await fetch(
        `/demo/files/${encodeURIComponent(result.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("The file could not be removed");
    },
  });
  stores.set(example.id, store);
  if (["http", "indeterminate"].includes(example.id)) {
    const input = root.querySelector<HTMLInputElement>("[data-upload-input]")!;
    input.multiple = false;
    root.querySelector("h3")!.textContent = "Choose a document";
    root.querySelector(".dropzone")!.classList.add("single-request");
  }
  if (example.id === "limits") {
    root.querySelector(".settings")!.innerHTML =
      '<label><input type="checkbox" data-disabled> Disabled</label><label><input type="checkbox" data-readonly> Read-only</label>';
    root
      .querySelector<HTMLInputElement>("[data-disabled]")!
      .addEventListener("change", (event) =>
        store.setOptions({
          disabled: (event.target as HTMLInputElement).checked,
        }),
      );
    root
      .querySelector<HTMLInputElement>("[data-readonly]")!
      .addEventListener("change", (event) =>
        store.setOptions({
          readOnly: (event.target as HTMLInputElement).checked,
        }),
      );
    root.querySelector<HTMLInputElement>("[data-upload-input]")!.accept =
      "image/*";
  }
  section
    .querySelector("[data-fail]")
    ?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      await fetch("/demo/fail-next", {
        method: "POST",
        headers: { "X-Demo-Example": example.id },
      });
      button.textContent = "Next request will fail";
      setTimeout(() => (button.textContent = "Reject next request"), 2200);
    });
  const mounted = mountUploader(root, store, {
    renderItem: (item) => row(item, store),
    renderMetadata: (item) =>
      `${formatBytes(item.totalBytes)} · ${item.metadata.type || "Unknown format"}`,
    renderProgress(element, item) {
      element.querySelector<HTMLElement>(".progress-fill")!.style.width =
        item.progress === null ? "25%" : `${item.progress}%`;
      element.toggleAttribute("data-indeterminate", item.progress === null);
      element.toggleAttribute(
        "data-active",
        ["uploading", "retrying", "finalizing"].includes(item.status),
      );
      element.querySelector("[data-percentage]")!.textContent =
        item.progress === null ? "Sending" : `${Math.round(item.progress)}%`;
      element.querySelector("[data-metrics]")!.textContent =
        `${formatBytes(item.uploadedBytes)} saved / ${formatBytes(item.totalBytes)}${item.bytesPerSecond ? ` · ${formatBytes(item.bytesPerSecond)}/s` : ""}${item.etaSeconds !== null ? ` · about ${Math.ceil(item.etaSeconds)}s left` : ""}`;
      const count = item.session
        ? Math.max(1, Math.ceil(item.totalBytes / item.session.chunkSize))
        : 0;
      const strip = element.querySelector(".part-strip")!;
      const visualCount = Math.min(count, 120);
      if (strip.children.length !== visualCount)
        strip.innerHTML = "<i></i>".repeat(visualCount);
      const confirmed = new Set(item.parts.map((part) => part.index));
      Array.from(strip.children).forEach((block, index) => {
        const start = Math.floor((index * count) / visualCount),
          end = Math.floor(((index + 1) * count) / visualCount);
        block.toggleAttribute(
          "data-confirmed",
          Array.from({ length: end - start }, (_, i) => start + i).every((i) =>
            confirmed.has(i),
          ),
        );
      });
      const row = element.closest(".file-row")!;
      row.querySelector("[data-item-error]")!.textContent =
        item.error?.message ?? item.removeError?.message ?? "";
      row.querySelector<HTMLElement>("[data-select-original]")!.hidden =
        item.status !== "awaiting-file";
      const show: Record<string, boolean> = {
        start: item.status === "idle",
        pause: [
          "uploading",
          "verifying",
          "retrying",
          "queued",
          "finalizing",
        ].includes(item.status),
        resume: item.status === "paused",
        retry:
          ["failed", "canceled"].includes(item.status) &&
          !!item.file &&
          item.error?.code !== "VALIDATION",
        cancel: !["completed", "canceled", "failed"].includes(item.status),
        reset: !["completed", "idle", "validating"].includes(item.status),
        remove: item.status === "completed",
        forget: ["completed", "canceled", "failed"].includes(item.status),
      };
      row
        .querySelectorAll<HTMLButtonElement>("[data-upload-action]")
        .forEach((button) => {
          button.hidden = !show[button.dataset.uploadAction!];
        });
    },
    renderPreview(element, item, url) {
      if (example.id !== "gallery") return;
      if (item.metadata.type.startsWith("video/") && url) {
        let video = element.querySelector("video");
        if (!video) {
          video = document.createElement("video");
          video.controls = true;
          video.className = "preview-image";
          element.replaceChildren(video);
        }
        if (video.src !== url) video.src = url;
      } else if (item.metadata.type.startsWith("image/") && url) {
        let image = element.querySelector("img");
        if (!image) {
          image = document.createElement("img");
          image.className = "preview-image";
          image.alt = item.metadata.name;
          element.replaceChildren(image);
        }
        if (image.src !== url) image.src = url;
      } else
        element.textContent =
          item.metadata.type || "No preview for this format";
    },
    onSnapshot(snapshot) {
      root.querySelector<HTMLElement>(".empty")!.hidden =
        snapshot.items.length > 0;
      root.querySelector("[data-error]")!.textContent =
        snapshot.persistenceError?.message ?? "";
      const cleanups = root.querySelector(".cleanups")!;
      cleanups.innerHTML = snapshot.cleanups
        .filter((record) => record.status === "failed")
        .map(
          (record) =>
            `<div class="cleanup"><span class="error">${escape(record.metadata.name)}: ${escape(record.error?.message ?? "Cleaning up temporary data")}</span>${record.status === "failed" ? `<button type="button" data-cleanup-id="${escape(record.id)}">Retry cleanup</button>` : ""}</div>`,
        )
        .join("");
      cleanups
        .querySelectorAll<HTMLButtonElement>("[data-cleanup-id]")
        .forEach((button) =>
          button.addEventListener(
            "click",
            () => void store.retryCleanup(button.dataset.cleanupId!),
          ),
        );
    },
  });
  owned.push(() => {
    mounted.destroy();
    store.destroy();
  });
}
const historySection = document.querySelector<HTMLElement>("#history")!;
let historyLanguage = "React";
const historyCode = historySection.querySelector("pre code")!;
historyCode.textContent = snippet(historyLanguage, "history");
for (const button of historySection.querySelectorAll<HTMLButtonElement>(
  "[data-tab]",
))
  button.addEventListener("click", () => {
    historySection
      .querySelectorAll("[data-tab]")
      .forEach((tab) =>
        tab.setAttribute("aria-selected", String(tab === button)),
      );
    historySection
      .querySelectorAll<HTMLElement>("[data-panel]")
      .forEach(
        (panel) => (panel.hidden = panel.dataset.panel !== button.dataset.tab),
      );
  });
for (const button of historySection.querySelectorAll<HTMLButtonElement>(
  "[data-language]",
))
  button.addEventListener("click", () => {
    historyLanguage = button.dataset.language!;
    historySection
      .querySelectorAll("[data-language]")
      .forEach((tab) =>
        tab.setAttribute("aria-selected", String(tab === button)),
      );
    historyCode.textContent = snippet(historyLanguage, "history");
  });
historySection
  .querySelector("[data-copy]")!
  .addEventListener("click", () =>
    navigator.clipboard.writeText(historyCode.textContent!),
  );
historySection
  .querySelector("[data-fail-remove]")!
  .addEventListener("click", () =>
    fetch("/demo/fail-next-remove", { method: "POST" }),
  );
const historyStore = createUploader({
  transport: chunkedTransport({ baseURL: "/uploads" }),
  async loadHistory(_cursor, signal) {
    const response = await fetch("/demo/history", { signal });
    if (!response.ok) throw new Error("Could not load uploaded files");
    return { items: await response.json() };
  },
  async onRemove(item) {
    const result = item.result as { id: string };
    const response = await fetch(
      "/demo/files/" + encodeURIComponent(result.id),
      { method: "DELETE" },
    );
    if (!response.ok) throw new Error("Could not remove the file");
  },
});
const historyMount = mountUploader(historySection, historyStore, {
  renderItem() {
    const row = document.createElement("article");
    row.className = "history-row";
    row.innerHTML =
      '<div><span data-upload-name></span><small data-upload-metadata></small><span data-upload-status class="error"></span></div><button type="button" data-upload-action="remove">Remove</button>';
    return row;
  },
  renderMetadata: (item) => formatBytes(item.totalBytes),
  renderStatus: (item) =>
    item.removeError?.message ?? (item.removing ? "Removing" : ""),
});
historySection
  .querySelector("[data-refresh]")!
  .addEventListener("click", async () => {
    const error = historySection.querySelector("[data-history-error]")!;
    try {
      await historyStore.loadHistory();
      error.textContent = "";
    } catch (value) {
      error.textContent =
        value instanceof Error ? value.message : String(value);
    }
  });
owned.push(() => {
  historyMount.destroy();
  historyStore.destroy();
});
const countdownTimer = setInterval(() => {
  for (const [key, store] of stores) {
    document
      .getElementById(key)
      ?.querySelectorAll<HTMLElement>("[data-upload-id]")
      .forEach((element) => {
        const item = store.getItem(element.dataset.uploadId!);
        const label = element.querySelector("[data-retry-countdown]");
        if (label)
          label.textContent =
            item?.status === "retrying" && item.nextRetryAt
              ? `Attempt ${item.attempt} failed. Retrying in ${Math.max(0, Math.ceil((item.nextRetryAt - Date.now()) / 1000))}s`
              : "";
      });
  }
}, 250);
owned.push(() => clearInterval(countdownTimer));
if (import.meta.hot)
  import.meta.hot.dispose(() => owned.forEach((dispose) => dispose()));
