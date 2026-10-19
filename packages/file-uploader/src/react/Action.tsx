import { forwardRef, useContext, type ButtonHTMLAttributes } from "react";
import type { UploaderStore } from "../core";
import {
  ItemContext,
  useUploaderControls,
  useUploaderContext,
} from "./context";
export type UploadAction =
  | "start"
  | "pause"
  | "resume"
  | "retry"
  | "cancel"
  | "reset"
  | "remove"
  | "forget";
export const Action = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    action: UploadAction;
    itemId?: string;
  }
>(function Action(
  { action, itemId, onClick, disabled, type = "button", ...props },
  ref,
) {
  const inherited = useContext(ItemContext),
    { store } = useUploaderContext(),
    state = useUploaderControls(),
    id = itemId ?? inherited ?? undefined;
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={
        disabled ||
        state.disabled ||
        state.readOnly ||
        (action !== "start" && !id)
      }
      data-action={action}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (action === "start") store.start(id);
        else if (id) void (store[action] as UploaderStore["pause"])(id);
      }}
    />
  );
});
