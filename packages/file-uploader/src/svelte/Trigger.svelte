<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { useUploaderControls, useUploaderContext } from "./context";
  let {
    onclick,
    disabled,
    children,
    type = "button",
    ...attrs
  }: HTMLButtonAttributes & { children?: Snippet } = $props();
  const context = useUploaderContext(),
    state = useUploaderControls();
</script>

<button
  {...attrs}
  {type}
  disabled={disabled || $state.disabled || $state.readOnly}
  onclick={(event) => {
    onclick?.(event);
    if (!event.defaultPrevented)
      [...context.inputs].find((input) => !input.disabled)?.click();
  }}>{@render children?.()}</button
>
