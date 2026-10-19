import {
  forwardRef,
  useEffect,
  useRef,
  type InputHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
} from "react";
import { useUploaderControls, useUploaderContext } from "./context";
export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ onChange, disabled, ...props }, forwarded) {
  const context = useUploaderContext(),
    state = useUploaderControls(),
    ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    context.inputs.add(input);
    return () => {
      context.inputs.delete(input);
    };
  }, [context]);
  return (
    <input
      {...props}
      type="file"
      disabled={disabled || state.disabled || state.readOnly}
      ref={(node) => {
        ref.current = node;
        if (typeof forwarded === "function") forwarded(node);
        else if (forwarded) forwarded.current = node;
      }}
      onChange={(event) => {
        onChange?.(event);
        if (event.defaultPrevented) return;
        void context.store.add(Array.from(event.currentTarget.files ?? []));
        event.currentTarget.value = "";
      }}
    />
  );
});
export const Trigger = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(function Trigger({ onClick, disabled, type = "button", ...props }, ref) {
  const { inputs } = useUploaderContext(),
    state = useUploaderControls();
  return (
    <button
      {...props}
      type={type}
      ref={ref}
      disabled={disabled || state.disabled || state.readOnly}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented)
          [...inputs].find((input) => !input.disabled)?.click();
      }}
    />
  );
});
export const Dropzone = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function Dropzone(
  { onDrop, onDragOver, onDragLeave, onDragEnter, ...props },
  ref,
) {
  const context = useUploaderContext(),
    state = useUploaderControls();
  return (
    <div
      {...props}
      ref={ref}
      data-disabled={state.disabled || undefined}
      data-readonly={state.readOnly || undefined}
      aria-disabled={state.disabled || state.readOnly || undefined}
      onDragEnter={(event) => {
        onDragEnter?.(event);
        if (!event.defaultPrevented && !state.disabled && !state.readOnly)
          event.currentTarget.dataset.dragging = "true";
      }}
      onDragLeave={(event) => {
        onDragLeave?.(event);
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          delete event.currentTarget.dataset.dragging;
      }}
      onDragOver={(event) => {
        onDragOver?.(event);
        if (!state.disabled && !state.readOnly && !event.defaultPrevented) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        onDrop?.(event);
        delete event.currentTarget.dataset.dragging;
        if (event.defaultPrevented || state.disabled || state.readOnly) return;
        event.preventDefault();
        void context.store.add(Array.from(event.dataTransfer.files));
      }}
    />
  );
});
