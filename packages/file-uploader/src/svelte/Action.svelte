<script lang="ts">
  import { getContext, type Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { useUploaderControls, useUploaderStore, itemKey } from "./context";
  type Action =
    | "start"
    | "pause"
    | "resume"
    | "retry"
    | "cancel"
    | "reset"
    | "remove"
    | "forget";
  let {
    action,
    itemId,
    children,
    onclick,
    disabled,
    type = "button",
    ...attrs
  }: HTMLButtonAttributes & {
    action: Action;
    itemId?: string;
    children?: Snippet;
  } = $props();
  const inherited = getContext<string>(itemKey),
    store = useUploaderStore(),
    snapshot = useUploaderControls();
</script>

<button
  {...attrs}
  {type}
  data-action={action}
  disabled={disabled || $snapshot.disabled || $snapshot.readOnly}
  onclick={(event) => {
    onclick?.(event);
    if (event.defaultPrevented) return;
    const id = itemId ?? inherited;
    if (action === "start") store.start(id);
    else if (id) void store[action](id);
  }}>{@render children?.()}</button
>
