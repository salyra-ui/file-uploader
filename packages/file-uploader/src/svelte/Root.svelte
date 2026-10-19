<script lang="ts">
  import {
    setContext,
    onMount,
    onDestroy,
    untrack,
    type Snippet,
  } from "svelte";
  import {
    createUploader,
    type UploaderOptions,
    type UploaderStore,
  } from "../core";
  import { uploaderKey } from "./context";
  let {
    store,
    options,
    restore = true,
    children,
  }: {
    store?: UploaderStore;
    options?: UploaderOptions;
    restore?: boolean;
    children?: Snippet;
  } = $props();
  const provided = untrack(() => store);
  const instance =
    provided ??
    createUploader(
      untrack(() => options) ??
        (() => {
          throw new Error("Root requires a store or options");
        })(),
    );
  setContext(uploaderKey, {
    store: instance,
    inputs: new Set<HTMLInputElement>(),
  });
  onMount(() => {
    if (restore) void instance.restore();
  });
  onDestroy(() => {
    if (!provided) instance.destroy();
  });
</script>

{@render children?.()}
