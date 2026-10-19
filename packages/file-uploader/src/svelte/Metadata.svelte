<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { useUploadItem } from "./context";
  import type { UploadItem } from "../core";
  let {
    children,
    format,
    ...attrs
  }: Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
    children?: Snippet<[UploadItem]>;
    format?: (item: UploadItem) => string;
  } = $props();
  const item = useUploadItem();
</script>

<span {...attrs}
  >{#if $item}{#if children}{@render children($item)}{:else}{format?.($item) ??
        ""}{/if}{/if}</span
>
