<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { useUploaderControls, useUploaderContext } from "./context";
  let {
    ondrop,
    ondragover,
    ondragenter,
    ondragleave,
    children,
    ...attrs
  }: HTMLAttributes<HTMLDivElement> & { children?: Snippet } = $props();
  const context = useUploaderContext(),
    snapshot = useUploaderControls();
  let dragging = $state(false);
</script>

<div
  {...attrs}
  role={attrs.role ?? "group"}
  data-dragging={dragging || undefined}
  aria-disabled={$snapshot.disabled || $snapshot.readOnly || undefined}
  ondragover={(event) => {
    ondragover?.(event);
    if (!event.defaultPrevented && !$snapshot.disabled && !$snapshot.readOnly)
      event.preventDefault();
  }}
  ondragenter={(event) => {
    ondragenter?.(event);
    if (!event.defaultPrevented && !$snapshot.disabled && !$snapshot.readOnly)
      dragging = true;
  }}
  ondragleave={(event) => {
    ondragleave?.(event);
    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
      dragging = false;
  }}
  ondrop={(event) => {
    ondrop?.(event);
    dragging = false;
    if (event.defaultPrevented || $snapshot.disabled || $snapshot.readOnly)
      return;
    event.preventDefault();
    void context.store.add(Array.from(event.dataTransfer?.files ?? []));
  }}
>
  {@render children?.()}
</div>
