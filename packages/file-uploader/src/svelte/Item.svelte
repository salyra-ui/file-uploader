<script lang="ts">
  import { setContext, untrack, type Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { itemKey, useUploadItem } from "./context";
  import type { UploadItem } from "../core";
  let {
    id,
    children,
    as = "li",
    ...attrs
  }: Omit<HTMLAttributes<HTMLLIElement>, "children"> & {
    as?: string;
    id: string;
    children?: Snippet<[UploadItem]>;
  } = $props();
  const key = untrack(() => id);
  setContext(itemKey, key);
  const item = useUploadItem(key);
</script>

{#if $item}<svelte:element
    this={as}
    {...attrs}
    data-upload-id={id}
    data-state={$item.status}>{@render children?.($item)}</svelte:element
  >{/if}
