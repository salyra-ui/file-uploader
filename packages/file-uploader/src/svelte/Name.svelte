<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { useUploadItem } from "./context";
  let {
    children,
    ...attrs
  }: HTMLAttributes<HTMLSpanElement> & { children?: Snippet } = $props();
  const item = useUploadItem();
</script>

<span {...attrs}
  >{#if children}{@render children()}{:else}{$item?.metadata.name ??
      ""}{/if}</span
>
