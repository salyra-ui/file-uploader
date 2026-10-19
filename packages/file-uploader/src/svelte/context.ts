import { getContext } from "svelte";
import { readable } from "svelte/store";
import type { UploaderStore, UploaderSnapshot } from "../core";
export const uploaderKey = Symbol("SalyraUploader"),
  itemKey = Symbol("SalyraUploadItem");
export interface UploaderContext {
  store: UploaderStore;
  inputs: Set<HTMLInputElement>;
}
export function useUploaderContext() {
  const context = getContext<UploaderContext>(uploaderKey);
  if (!context)
    throw new Error("Place this component inside FileUploader.Root");
  return context;
}
export function useUploaderStore() {
  return useUploaderContext().store;
}
export function useUploader() {
  const store = useUploaderStore();
  return readable(store.getSnapshot(), (set) =>
    store.subscribe(() => set(store.getSnapshot())),
  );
}
export function useUploadItem(id = getContext<string>(itemKey)) {
  if (!id) throw new Error("An upload item ID is required");
  const store = useUploaderStore();
  return readable<import("../core").UploadItem | undefined>(
    store.getItem(id),
    (set) => store.subscribeItem(id, () => set(store.getItem(id))),
  );
}
export function useUploadIDs() {
  const store = useUploaderStore();
  let key = "";
  return readable<string[]>([], (set) => {
    const update = () => {
      const ids = store.getSnapshot().items.map((item) => item.id),
        next = JSON.stringify(ids);
      if (key !== next) {
        key = next;
        set(ids);
      }
    };
    update();
    return store.subscribe(update);
  });
}

export function useUploaderControls() {
  const store = useUploaderStore();
  const flags = () => ({
    disabled: store.getSnapshot().disabled,
    readOnly: store.getSnapshot().readOnly,
  });
  return readable(flags(), (set) => {
    let value = flags();
    return store.subscribe(() => {
      const next = flags();
      if (
        next.disabled !== value.disabled ||
        next.readOnly !== value.readOnly
      ) {
        value = next;
        set(next);
      }
    });
  });
}
