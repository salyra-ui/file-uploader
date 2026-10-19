<script lang="ts">
  import type { Snippet } from "svelte";
  import { useUploader } from "./context";
  import type { UploaderSnapshot } from "../core";
  let { children }: { children: Snippet<[UploaderSnapshot]> } = $props();
  const snapshot = useUploader();
</script>

{@render children($snapshot)}
