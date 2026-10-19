<script lang="ts">
  import { FileUploader } from "../../../packages/file-uploader/src/svelte";
  import { createUploader } from "../../../packages/file-uploader/src/core";
  import { chunkedTransport } from "../../../packages/file-uploader/src/transport/chunked";
  import { onDestroy } from "svelte";
  const store = createUploader({
    transport: chunkedTransport({ baseURL: "/uploads" }),
    chunkSize: 262144,
  });
  onDestroy(() => store.destroy());
</script>

<FileUploader.Root {store}>
  <FileUploader.Input aria-label="Select files" multiple />
  <FileUploader.Action action="start">Upload</FileUploader.Action>
  <FileUploader.Action
    action="start"
    onclick={(event) => event.preventDefault()}
    >Blocked upload</FileUploader.Action
  >
  <FileUploader.Action action="start" disabled
    >Disabled upload</FileUploader.Action
  >
  <button onclick={() => store.setOptions({ disabled: true })}
    >Disable root</button
  >
  <FileUploader.List as="div">
    {#snippet children(ids)}
      {#each ids as id (id)}
        <FileUploader.Item as="article" {id} class="custom-row"
          ><FileUploader.Name /><FileUploader.Status /><FileUploader.Action
            action="cancel">Cancel</FileUploader.Action
          ><FileUploader.Action action="retry">Retry</FileUploader.Action
          ><FileUploader.Progress aria-label="Upload progress"
            >{#snippet children(item)}{Math.round(
                item.progress ?? 0,
              )}%{/snippet}</FileUploader.Progress
          ></FileUploader.Item
        >
      {/each}
    {/snippet}
  </FileUploader.List>
</FileUploader.Root>
