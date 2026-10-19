import {
  inject,
  onScopeDispose,
  shallowRef,
  watch,
  type InjectionKey,
  type MaybeRefOrGetter,
  toValue,
} from "vue";
import type { UploaderStore } from "../core";
export const UploaderKey: InjectionKey<{
  store: UploaderStore;
  inputs: Set<HTMLInputElement>;
}> = Symbol("SalyraUploader");
export const ItemKey: InjectionKey<MaybeRefOrGetter<string>> =
  Symbol("SalyraUploadItem");
export function useUploaderStore() {
  const value = inject(UploaderKey);
  if (!value) throw new Error("Place this component inside FileUploader.Root");
  return value.store;
}
export function useUploader() {
  const store = useUploaderStore(),
    state = shallowRef(store.getSnapshot());
  const unsubscribe = store.subscribe(
    () => (state.value = store.getSnapshot()),
  );
  onScopeDispose(unsubscribe);
  return state;
}
export function useUploadItem(id?: MaybeRefOrGetter<string | undefined>) {
  const inherited = inject(ItemKey, undefined),
    store = useUploaderStore(),
    item = shallowRef();
  let stop: (() => void) | undefined;
  watch(
    () => toValue(id) ?? toValue(inherited),
    (key) => {
      stop?.();
      if (!key) throw new Error("An upload item ID is required");
      item.value = store.getItem(key);
      stop = store.subscribeItem(key, () => (item.value = store.getItem(key)));
    },
    { immediate: true },
  );
  onScopeDispose(() => stop?.());
  return item as import("vue").ShallowRef<
    import("../core").UploadItem | undefined
  >;
}

export function useUploaderControls() {
  const store = useUploaderStore();
  const flags = () => ({
    disabled: store.getSnapshot().disabled,
    readOnly: store.getSnapshot().readOnly,
  });
  const value = shallowRef(flags());
  onScopeDispose(
    store.subscribe(() => {
      const next = flags();
      if (
        next.disabled !== value.value.disabled ||
        next.readOnly !== value.value.readOnly
      )
        value.value = next;
    }),
  );
  return value;
}
