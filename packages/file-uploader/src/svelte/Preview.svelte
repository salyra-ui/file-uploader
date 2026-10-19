<script lang="ts">
  import type { Snippet } from "svelte";
  import { useUploadItem } from "./context";
  import type { UploadItem } from "../core";
  let {
    children,
  }: { children: Snippet<[{ item: UploadItem; url?: string }]> } = $props();
  const item = useUploadItem();
  let url = $state<string>();
  $effect(() => {
    const file = $item?.file;
    if (!file) {
      url = undefined;
      return;
    }
    const next = URL.createObjectURL(file);
    url = next;
    return () => URL.revokeObjectURL(next);
  });
</script>

{#if $item}{@render children({ item: $item, url })}{/if}
