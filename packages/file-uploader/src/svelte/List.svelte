<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { useUploadIDs } from "./context";
  let {
    children,
    as = "ul",
    ...attrs
  }: Omit<HTMLAttributes<HTMLUListElement>, "children"> & {
    as?: string;
    children: Snippet<[string[]]>;
  } = $props();
  const ids = useUploadIDs();
</script>

<svelte:element this={as} {...attrs}>{@render children($ids)}</svelte:element>
