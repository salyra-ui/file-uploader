<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { useUploadItem } from "./context";
  import type { UploadItem } from "../core";
  let {
    children,
    labels,
    ...attrs
  }: Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
    children?: Snippet<[UploadItem]>;
    labels?: Partial<Record<UploadItem["status"], string>>;
  } = $props();
  const item = useUploadItem();
</script>

<span {...attrs} data-state={$item?.status}
  >{#if $item}{#if children}{@render children($item)}{:else}{labels?.[
        $item.status
      ] ?? $item.status}{/if}{/if}</span
>
