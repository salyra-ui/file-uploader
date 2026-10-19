<script lang="ts">
  import { onMount } from "svelte";
  import type { HTMLInputAttributes } from "svelte/elements";
  import { useUploaderControls, useUploaderContext } from "./context";
  let { onchange, disabled, ...attrs }: HTMLInputAttributes = $props();
  let element: HTMLInputElement;
  const context = useUploaderContext(),
    state = useUploaderControls();
  onMount(() => {
    context.inputs.add(element);
    return () => {
      context.inputs.delete(element);
    };
  });
</script>

<input
  {...attrs}
  type="file"
  bind:this={element}
  disabled={disabled || $state.disabled || $state.readOnly}
  onchange={(event) => {
    onchange?.(event);
    if (event.defaultPrevented) return;
    void context.store.add(Array.from(element.files ?? []));
    element.value = "";
  }}
/>
