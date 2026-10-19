import {
  defineComponent,
  h,
  inject,
  mergeProps,
  onMounted,
  onScopeDispose,
  ref,
} from "vue";
import { UploaderKey, useUploaderControls } from "./context";
export const Input = defineComponent({
  name: "FileUploaderInput",
  inheritAttrs: false,
  setup(_, { attrs }) {
    const context = inject(UploaderKey)!,
      state = useUploaderControls(),
      input = ref<HTMLInputElement>();
    onMounted(() => {
      if (input.value) context.inputs.add(input.value);
    });
    onScopeDispose(() => {
      if (input.value) context.inputs.delete(input.value);
    });
    return () =>
      h(
        "input",
        mergeProps(attrs, {
          type: "file",
          ref: input,
          disabled:
            attrs.disabled || state.value.disabled || state.value.readOnly,
          onChange(event: Event) {
            if (event.defaultPrevented) return;
            const target = event.currentTarget as HTMLInputElement;
            void context.store.add(Array.from(target.files ?? []));
            target.value = "";
          },
        }),
      );
  },
});
export const Trigger = defineComponent({
  name: "FileUploaderTrigger",
  inheritAttrs: false,
  setup(_, { attrs, slots }) {
    const context = inject(UploaderKey)!,
      state = useUploaderControls();
    return () =>
      h(
        "button",
        mergeProps({ type: "button" }, attrs, {
          disabled:
            attrs.disabled || state.value.disabled || state.value.readOnly,
          onClick(event: Event) {
            if (!event.defaultPrevented)
              [...context.inputs].find((input) => !input.disabled)?.click();
          },
        }),
        slots.default?.(),
      );
  },
});
export const Dropzone = defineComponent({
  name: "FileUploaderDropzone",
  inheritAttrs: false,
  setup(_, { attrs, slots }) {
    const context = inject(UploaderKey)!,
      state = useUploaderControls(),
      dragging = ref(false);
    const blocked = () => state.value.disabled || state.value.readOnly;
    return () =>
      h(
        "div",
        mergeProps(attrs, {
          "data-dragging": dragging.value || undefined,
          "aria-disabled": blocked() || undefined,
          onDragover(event: DragEvent) {
            if (!blocked() && !event.defaultPrevented) event.preventDefault();
          },
          onDragenter(event: DragEvent) {
            if (!blocked() && !event.defaultPrevented) dragging.value = true;
          },
          onDragleave(event: DragEvent) {
            if (
              !(event.currentTarget as HTMLElement).contains(
                event.relatedTarget as Node | null,
              )
            )
              dragging.value = false;
          },
          onDrop(event: DragEvent) {
            dragging.value = false;
            if (blocked() || event.defaultPrevented) return;
            event.preventDefault();
            void context.store.add(Array.from(event.dataTransfer?.files ?? []));
          },
        }),
        slots.default?.({ dragging: dragging.value }),
      );
  },
});
