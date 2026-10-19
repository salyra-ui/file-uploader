import {
  defineComponent,
  onMounted,
  onScopeDispose,
  provide,
  type PropType,
} from "vue";
import {
  createUploader,
  type UploaderOptions,
  type UploaderStore,
} from "../core";
import { UploaderKey } from "./context";
export const Root = defineComponent({
  name: "FileUploaderRoot",
  inheritAttrs: false,
  props: {
    store: Object as PropType<UploaderStore>,
    options: Object as PropType<UploaderOptions>,
    restore: { type: Boolean, default: true },
  },
  setup(props, { slots }) {
    if (!props.store && !props.options)
      throw new Error("Root requires a store or options");
    const provided = props.store;
    const store = provided ?? createUploader(props.options!);
    provide(UploaderKey, { store, inputs: new Set<HTMLInputElement>() });
    onMounted(() => {
      if (props.restore) void store.restore();
    });
    onScopeDispose(() => {
      if (!provided) store.destroy();
    });
    return () => slots.default?.({ store });
  },
});
