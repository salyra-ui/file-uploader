import {
  defineComponent,
  h,
  mergeProps,
  onScopeDispose,
  provide,
  shallowRef,
  watch,
  type PropType,
} from "vue";
import type { UploadItem } from "../core";
import {
  ItemKey,
  useUploadItem,
  useUploader,
  useUploaderStore,
} from "./context";
export const List = defineComponent({
  name: "FileUploaderList",
  inheritAttrs: false,
  props: { as: { type: String, default: "ul" } },
  setup(props, { attrs, slots }) {
    const store = useUploaderStore(),
      ids = shallowRef(store.getSnapshot().items.map((item) => item.id));
    onScopeDispose(
      store.subscribe(() => {
        const next = store.getSnapshot().items.map((item) => item.id);
        if (next.join("|") !== ids.value.join("|")) ids.value = next;
      }),
    );
    return () => h(props.as, attrs, slots.default?.({ ids: ids.value }));
  },
});
export const Item = defineComponent({
  name: "FileUploaderItem",
  inheritAttrs: false,
  props: {
    id: { type: String, required: true },
    as: { type: String, default: "li" },
  },
  setup(props, { attrs, slots }) {
    provide(ItemKey, () => props.id);
    const item = useUploadItem(() => props.id);
    return () =>
      item.value &&
      h(
        props.as,
        mergeProps(attrs, {
          "data-state": item.value.status,
          "data-upload-id": props.id,
        }),
        slots.default?.({ item: item.value }),
      );
  },
});
export const Name = defineComponent({
  name: "FileUploaderName",
  setup(_, { attrs, slots }) {
    const item = useUploadItem();
    return () =>
      h(
        "span",
        attrs,
        slots.default?.({ item: item.value }) ?? item.value?.metadata.name,
      );
  },
});
export const Metadata = defineComponent({
  name: "FileUploaderMetadata",
  props: { format: Function as PropType<(item: UploadItem) => string> },
  setup(props, { attrs, slots }) {
    const item = useUploadItem();
    return () =>
      h(
        "span",
        attrs,
        slots.default?.({ item: item.value }) ??
          (item.value && props.format?.(item.value)),
      );
  },
});
export const Status = defineComponent({
  name: "FileUploaderStatus",
  props: {
    labels: Object as PropType<Partial<Record<UploadItem["status"], string>>>,
  },
  setup(props, { attrs, slots }) {
    const item = useUploadItem();
    return () =>
      h(
        "span",
        mergeProps(attrs, { "data-state": item.value?.status }),
        slots.default?.({ item: item.value }) ??
          (item.value &&
            (props.labels?.[item.value.status] ?? item.value.status)),
      );
  },
});
export const Progress = defineComponent({
  name: "FileUploaderProgress",
  inheritAttrs: false,
  setup(_, { attrs, slots }) {
    const item = useUploadItem();
    return () =>
      item.value &&
      h(
        "div",
        mergeProps(attrs, {
          role: "progressbar",
          "aria-valuemin": 0,
          "aria-valuemax": 100,
          "aria-valuenow": item.value.progress ?? undefined,
          "data-state": item.value.status,
          "data-indeterminate": item.value.progress === null || undefined,
        }),
        slots.default?.({ item: item.value }),
      );
  },
});
export const Output = defineComponent({
  name: "FileUploaderOutput",
  setup(_, { slots }) {
    const snapshot = useUploader();
    return () => slots.default?.({ snapshot: snapshot.value });
  },
});
export const Preview = defineComponent({
  name: "FileUploaderPreview",
  setup(_, { slots }) {
    const item = useUploadItem(),
      url = shallowRef<string>();
    watch(
      () => item.value?.file,
      (file) => {
        if (url.value) URL.revokeObjectURL(url.value);
        url.value =
          typeof window !== "undefined" && file
            ? URL.createObjectURL(file)
            : undefined;
      },
      { immediate: true },
    );
    onScopeDispose(() => {
      if (url.value) URL.revokeObjectURL(url.value);
    });
    return () => slots.default?.({ item: item.value, url: url.value });
  },
});
