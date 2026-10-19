import {
  createContext,
  useContext,
  useCallback,
  useSyncExternalStore,
} from "react";
import type { UploaderStore } from "../core";
export interface UploaderContextValue {
  store: UploaderStore;
  inputs: Set<HTMLInputElement>;
}
export const UploaderContext = createContext<UploaderContextValue | null>(null);
export const ItemContext = createContext<string | null>(null);
export function useUploaderContext() {
  const value = useContext(UploaderContext);
  if (!value) throw new Error("Place this component inside FileUploader.Root");
  return value;
}
export function useUploader() {
  const { store } = useUploaderContext();
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
export function useUploadItem(id?: string) {
  const inherited = useContext(ItemContext),
    { store } = useUploaderContext(),
    key = id ?? inherited;
  if (!key)
    throw new Error(
      "Pass an item ID or place this component inside FileUploader.Item",
    );
  return useSyncExternalStore(
    useCallback((fn) => store.subscribeItem(key, fn), [store, key]),
    () => store.getItem(key),
    () => store.getItem(key),
  );
}
export function useUploaderStore() {
  return useUploaderContext().store;
}

export function useUploaderControls() {
  const { store } = useUploaderContext();
  const flags = useSyncExternalStore(
    store.subscribe,
    () => `${store.getSnapshot().disabled}:${store.getSnapshot().readOnly}`,
    () => `${store.getSnapshot().disabled}:${store.getSnapshot().readOnly}`,
  );
  return {
    disabled: flags.split(":")[0] === "true",
    readOnly: flags.split(":")[1] === "true",
  };
}
