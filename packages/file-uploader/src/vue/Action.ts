import {
  defineComponent,
  h,
  inject,
  mergeProps,
  toValue,
  type PropType,
} from "vue";
import { ItemKey, useUploaderControls, useUploaderStore } from "./context";
export type UploadAction =
  | "start"
  | "pause"
  | "resume"
  | "retry"
  | "cancel"
  | "reset"
  | "remove"
  | "forget";
export const Action = defineComponent({
  name: "FileUploaderAction",
  inheritAttrs: false,
  props: {
    action: { type: String as PropType<UploadAction>, required: true },
    itemId: String,
  },
  setup(props, { attrs, slots }) {
    const inherited = inject(ItemKey, undefined),
      state = useUploaderControls(),
      store = useUploaderStore();
    return () =>
      h(
        "button",
        mergeProps({ type: "button" }, attrs, {
          disabled:
            attrs.disabled || state.value.disabled || state.value.readOnly,
          "data-action": props.action,
          onClick(event: Event) {
            if (event.defaultPrevented) return;
            const id = props.itemId ?? toValue(inherited);
            if (props.action === "start") store.start(id);
            else if (id) void store[props.action](id);
          },
        }),
        slots.default?.(),
      );
  },
});
