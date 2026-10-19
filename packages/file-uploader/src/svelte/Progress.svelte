<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { useUploadItem } from "./context";
  import type { UploadItem } from "../core";
  let {
    children,
    ...attrs
  }: Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
    children?: Snippet<[UploadItem]>;
  } = $props();
  const item = useUploadItem();
</script>

{#if $item}<div
    {...attrs}
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={$item.progress ?? undefined}
    data-state={$item.status}
    data-indeterminate={$item.progress === null || undefined}
  >
    {@render children?.($item)}
  </div>{/if}
