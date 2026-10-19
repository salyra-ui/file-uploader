import {
  createUploader,
  type UploadItem,
  type UploaderOptions,
  type UploaderStore,
  type UploaderSnapshot,
} from "../core";
export * from "../core";
export interface MountOptions {
  renderItem?(item: UploadItem): HTMLElement;
  renderName?(item: UploadItem): string;
  renderMetadata?(item: UploadItem): string;
  renderStatus?(item: UploadItem): string;
  renderProgress?(element: HTMLElement, item: UploadItem): void;
  renderPreview?(element: HTMLElement, item: UploadItem, url?: string): void;
  renderOutput?(element: HTMLElement, snapshot: UploaderSnapshot): void;
  onSnapshot?(snapshot: UploaderSnapshot): void;
}
/** App-owned markup is connected through data-upload-* attributes. Return value disposes all bindings. */
export function mountUploader(
  root: HTMLElement,
  source: UploaderStore | UploaderOptions,
  options: MountOptions = {},
) {
  const owned = !("getSnapshot" in source),
    store = owned ? createUploader(source) : (source as UploaderStore);
  const disposers: Array<() => void> = [],
    rows = new Map<string, { element: HTMLElement; dispose(): void }>();
  const nativeDisabled = new WeakMap<Element, boolean>();
  function listen(element: Element, name: string, listener: EventListener) {
    element.addEventListener(name, listener);
    disposers.push(() => element.removeEventListener(name, listener));
  }
  const local = <T extends Element>(selector: string): T[] =>
    Array.from(root.querySelectorAll<T>(selector)).filter(
      (element) =>
        !element.parentElement?.closest("[data-upload-root]") ||
        element.closest("[data-upload-root]") === root,
    );
  root.dataset.uploadRoot = "";
  function itemBindings(element: HTMLElement, id: string) {
    let url: string | undefined, file: File | undefined;
    const cleanups: Array<() => void> = [];
    const bind = (target: Element, event: string, fn: EventListener) => {
      target.addEventListener(event, fn);
      cleanups.push(() => target.removeEventListener(event, fn));
    };
    element.dataset.uploadId = id;
    element
      .querySelectorAll<HTMLButtonElement>("[data-upload-action]")
      .forEach((button) =>
        bind(button, "click", (event) => {
          if (event.defaultPrevented) return;
          const action = button.dataset.uploadAction;
          if (
            action &&
            [
              "start",
              "pause",
              "resume",
              "retry",
              "cancel",
              "reset",
              "remove",
              "forget",
            ].includes(action)
          )
            void store[action as "pause"](id);
        }),
      );
    const update = () => {
      const item = store.getItem(id);
      if (!item) return;
      element.dataset.state = item.status;
      element
        .querySelectorAll<HTMLElement>("[data-upload-name]")
        .forEach(
          (el) =>
            (el.textContent = options.renderName?.(item) ?? item.metadata.name),
        );
      element
        .querySelectorAll<HTMLElement>("[data-upload-metadata]")
        .forEach(
          (el) => (el.textContent = options.renderMetadata?.(item) ?? ""),
        );
      element
        .querySelectorAll<HTMLElement>("[data-upload-status]")
        .forEach(
          (el) =>
            (el.textContent = options.renderStatus?.(item) ?? item.status),
        );
      element
        .querySelectorAll<HTMLElement>("[data-upload-progress]")
        .forEach((el) => {
          el.setAttribute("role", "progressbar");
          el.setAttribute("aria-valuemin", "0");
          el.setAttribute("aria-valuemax", "100");
          if (item.progress === null) el.removeAttribute("aria-valuenow");
          else el.setAttribute("aria-valuenow", String(item.progress));
          options.renderProgress?.(el, item);
        });
      if (file !== item.file) {
        if (url) URL.revokeObjectURL(url);
        file = item.file;
        url = file ? URL.createObjectURL(file) : undefined;
      }
      element
        .querySelectorAll<HTMLElement>("[data-upload-preview]")
        .forEach((el) => options.renderPreview?.(el, item, url));
    };
    update();
    cleanups.push(store.subscribeItem(id, update));
    return () => {
      cleanups.forEach((dispose) => dispose());
      if (url) URL.revokeObjectURL(url);
    };
  }
  local<HTMLInputElement>("[data-upload-input]").forEach((input) => {
    input.type = "file";
    listen(input, "change", (event) => {
      if (event.defaultPrevented) return;
      void store.add(Array.from(input.files ?? []));
      input.value = "";
    });
  });
  local<HTMLElement>("[data-upload-trigger]").forEach((button) =>
    listen(button, "click", (event) => {
      if (!event.defaultPrevented)
        local<HTMLInputElement>("[data-upload-input]")
          .find((input) => !input.disabled)
          ?.click();
    }),
  );
  local<HTMLElement>("[data-upload-dropzone]").forEach((zone) => {
    const blocked = () =>
      store.getSnapshot().disabled || store.getSnapshot().readOnly;
    listen(zone, "dragover", (event) => {
      if (!blocked() && !event.defaultPrevented) event.preventDefault();
    });
    listen(zone, "dragenter", (event) => {
      if (!blocked() && !event.defaultPrevented) zone.dataset.dragging = "true";
    });
    listen(zone, "dragleave", (event) => {
      if (!zone.contains((event as DragEvent).relatedTarget as Node | null))
        delete zone.dataset.dragging;
    });
    listen(zone, "drop", (event) => {
      delete zone.dataset.dragging;
      if (event.defaultPrevented || blocked()) return;
      event.preventDefault();
      void store.add(
        Array.from((event as DragEvent).dataTransfer?.files ?? []),
      );
    });
  });
  local<HTMLButtonElement>("[data-upload-start]").forEach((button) =>
    listen(button, "click", (event) => {
      if (!event.defaultPrevented) store.start();
    }),
  );
  local<HTMLButtonElement>("[data-upload-action]")
    .filter((button) => !button.closest("[data-upload-id]"))
    .forEach((button) =>
      listen(button, "click", (event) => {
        if (event.defaultPrevented) return;
        const action = button.dataset.uploadAction,
          id = button.dataset.uploadItemId;
        if (action === "start") store.start(id);
        else if (
          id &&
          action &&
          [
            "pause",
            "resume",
            "retry",
            "cancel",
            "reset",
            "remove",
            "forget",
          ].includes(action)
        )
          void store[action as "pause"](id);
      }),
    );
  const update = () => {
    const snapshot = store.getSnapshot();
    root.dataset.disabled = String(snapshot.disabled);
    root.dataset.readonly = String(snapshot.readOnly);
    const ids = new Set(snapshot.items.map((item) => item.id));
    for (const [id, row] of rows)
      if (!ids.has(id)) {
        row.dispose();
        row.element.remove();
        rows.delete(id);
      }
    const list = local<HTMLElement>("[data-upload-list]")[0];
    if (list)
      for (const item of snapshot.items)
        if (!rows.has(item.id)) {
          const existing = Array.from(list.children).find(
            (el) => (el as HTMLElement).dataset.uploadId === item.id,
          ) as HTMLElement | undefined;
          const element = existing ?? options.renderItem?.(item);
          if (element) {
            if (!existing) list.append(element);
            rows.set(item.id, {
              element,
              dispose: itemBindings(element, item.id),
            });
          }
        }
    local<HTMLInputElement | HTMLButtonElement>(
      "[data-upload-input],[data-upload-trigger],[data-upload-start],[data-upload-action]",
    ).forEach((control) => {
      if (!nativeDisabled.has(control))
        nativeDisabled.set(control, control.disabled);
      control.disabled =
        nativeDisabled.get(control)! || snapshot.disabled || snapshot.readOnly;
    });
    local<HTMLElement>("[data-upload-output]").forEach((element) => {
      if (options.renderOutput) options.renderOutput(element, snapshot);
      else
        element.textContent = JSON.stringify(
          snapshot.items.map(({ id, metadata, status, result }) => ({
            id,
            metadata,
            status,
            result,
          })),
          null,
          2,
        );
    });
    options.onSnapshot?.(snapshot);
  };
  update();
  disposers.push(store.subscribe(update));
  void store.restore();
  return {
    store,
    destroy() {
      disposers.splice(0).forEach((dispose) => dispose());
      for (const row of rows.values()) row.dispose();
      rows.clear();
      if (owned) store.destroy();
    },
  };
}
