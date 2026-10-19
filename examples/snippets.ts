export const languages = [
  "React",
  "Svelte",
  "Vue",
  "Angular",
  "Astro",
  "Vanilla",
] as const;
function composition(language: string, kind: string) {
  const options = optionsSource(kind);
  const imports = importsSource(kind);
  switch (language) {
    case "React":
      return `import { FileUploader } from '@salyra-ui/file-uploader/react';\n${imports}\n${options}\n\nexport function UploadFiles() {\n  return (\n    <FileUploader.Root options={options}>\n      <FileUploader.Dropzone className="upload-zone">\n        <FileUploader.Input multiple className="sr-only" aria-label="Select files" />\n        <FileUploader.Trigger>Select files</FileUploader.Trigger>\n      </FileUploader.Dropzone>\n      <FileUploader.Action action="start">Upload</FileUploader.Action>\n      <FileUploader.List>\n        {ids => ids.map(id => (\n          <FileUploader.Item key={id} id={id}>\n            <FileUploader.Name />\n            <FileUploader.Metadata format={item => formatBytes(item.totalBytes)} />\n            <FileUploader.Progress aria-label="Upload progress">\n              {item => <span>{Math.round(item.progress ?? 0)}%</span>}\n            </FileUploader.Progress>\n            <FileUploader.Action action="pause">Pause</FileUploader.Action>\n            <FileUploader.Action action="resume">Resume</FileUploader.Action>\n          </FileUploader.Item>\n        ))}\n      </FileUploader.List>\n    </FileUploader.Root>\n  );\n}`;
    case "Svelte":
      return `<script lang="ts">\n  import { FileUploader } from '@salyra-ui/file-uploader/svelte';\n  ${imports}\n  ${options}\n</script>\n\n<FileUploader.Root {options}>\n  <FileUploader.Dropzone class="upload-zone">\n    <FileUploader.Input multiple class="sr-only" aria-label="Select files" />\n    <FileUploader.Trigger>Select files</FileUploader.Trigger>\n  </FileUploader.Dropzone>\n  <FileUploader.Action action="start">Upload</FileUploader.Action>\n  <FileUploader.List>\n    {#snippet children(ids)}\n      {#each ids as id (id)}\n        <FileUploader.Item {id}>\n          <FileUploader.Name />\n          <FileUploader.Metadata format={item => formatBytes(item.totalBytes)} />\n          <FileUploader.Progress aria-label="Upload progress">\n            {#snippet children(item)}{Math.round(item.progress ?? 0)}%{/snippet}\n          </FileUploader.Progress>\n          <FileUploader.Action action="pause">Pause</FileUploader.Action>\n          <FileUploader.Action action="resume">Resume</FileUploader.Action>\n        </FileUploader.Item>\n      {/each}\n    {/snippet}\n  </FileUploader.List>\n</FileUploader.Root>`;
    case "Vue":
      return `<script setup lang="ts">\nimport { FileUploader } from '@salyra-ui/file-uploader/vue';\n${imports}\n${options}\n</script>\n\n<template>\n  <FileUploader.Root :options="options">\n    <FileUploader.Dropzone class="upload-zone">\n      <FileUploader.Input multiple class="sr-only" aria-label="Select files" />\n      <FileUploader.Trigger>Select files</FileUploader.Trigger>\n    </FileUploader.Dropzone>\n    <FileUploader.Action action="start">Upload</FileUploader.Action>\n    <FileUploader.List v-slot="{ ids }">\n      <FileUploader.Item v-for="id in ids" :key="id" :id="id">\n        <FileUploader.Name />\n        <FileUploader.Metadata :format="item => formatBytes(item.totalBytes)" />\n        <FileUploader.Progress v-slot="{ item }" aria-label="Upload progress">\n          {{ Math.round(item.progress ?? 0) }}%\n        </FileUploader.Progress>\n        <FileUploader.Action action="pause">Pause</FileUploader.Action>\n        <FileUploader.Action action="resume">Resume</FileUploader.Action>\n      </FileUploader.Item>\n    </FileUploader.List>\n  </FileUploader.Root>\n</template>`;
    case "Angular":
      return `import { Component } from '@angular/core';\nimport { FileUploader } from '@salyra-ui/file-uploader/angular';\n${imports}\n${options}\n\n@Component({\n  selector: 'app-upload',\n  standalone: true,\n  imports: [FileUploader.Root, FileUploader.Input, FileUploader.Trigger, FileUploader.Dropzone, FileUploader.List, FileUploader.Item, FileUploader.Name, FileUploader.Progress, FileUploader.Action],\n  template: \`\n    <section [uploadRoot]="options">\n      <div uploadDropzone class="upload-zone">\n        <input uploadInput multiple class="sr-only" aria-label="Select files" />\n        <button type="button" uploadTrigger>Select files</button>\n      </div>\n      <button type="button" uploadAction="start">Upload</button>\n      <ul uploadList #list="uploadList">\n        @for (id of list.ids(); track id) {\n          <li [uploadItem]="id" #file="uploadItem">\n            <span uploadName></span>\n            <div uploadProgress aria-label="Upload progress">\n              {{ file.value()?.progress }}%\n            </div>\n            <button type="button" uploadAction="pause">Pause</button>\n            <button type="button" uploadAction="resume">Resume</button>\n          </li>\n        }\n      </ul>\n    </section>\n  \`,\n})\nexport class UploadFiles { readonly options = options; }`;
    case "Astro":
      return `---\nimport { FileUploader } from '@salyra-ui/file-uploader/astro';\n---\n\n<FileUploader.Root options={{ endpoint: '/uploads', chunkSize: 262144, maxConcurrentChunks: ${kind === "parallel" ? 3 : 1} }}>\n  <FileUploader.Dropzone class="upload-zone">\n    <FileUploader.Input multiple class="sr-only" aria-label="Select files" />\n    <FileUploader.Trigger>Select files</FileUploader.Trigger>\n  </FileUploader.Dropzone>\n  <FileUploader.Action action="start">Upload</FileUploader.Action>\n  <FileUploader.List>\n    <template data-upload-template>\n      <FileUploader.Item>\n        <FileUploader.Name />\n        <FileUploader.Status />\n        <FileUploader.Progress aria-label="Upload progress" />\n        <FileUploader.Action action="pause">Pause</FileUploader.Action>\n        <FileUploader.Action action="resume">Resume</FileUploader.Action>\n      </FileUploader.Item>\n    </template>\n  </FileUploader.List>\n</FileUploader.Root>`;
    default:
      return `${imports}import { mountUploader } from '@salyra-ui/file-uploader/vanilla';\n\n${options}\n\nconst mounted = mountUploader(document.querySelector('#uploader'), options, {\n  renderItem(item) {\n    const element = document.createElement('li');\n    element.innerHTML = \`\n      <span data-upload-name></span>\n      <span data-upload-metadata></span>\n      <div data-upload-progress aria-label="Upload progress"></div>\n      <button type="button" data-upload-action="pause">Pause</button>\n      <button type="button" data-upload-action="resume">Resume</button>\n    \`;\n    return element;\n  },\n  renderMetadata: item => formatBytes(item.totalBytes),\n  renderProgress: (element, item) => {\n    element.textContent = item.progress === null ? 'Uploading' : item.progress.toFixed(0) + '%';\n  },\n});\n\n// TypeScript module. Use these data attributes in your HTML.\n// Dispose when this part of the page is removed.\n// mounted.destroy();\n\n/* Markup\n<section id="uploader">\n  <div data-upload-dropzone class="upload-zone">\n    <input type="file" multiple data-upload-input aria-label="Select files" />\n    <button type="button" data-upload-trigger>Select files</button>\n  </div>\n  <button type="button" data-upload-start>Upload</button>\n  <ul data-upload-list></ul>\n</section>\n*/`;
  }
}

function importsSource(kind: string) {
  const http = kind === "http" || kind === "indeterminate";
  return `import { createUploader, formatBytes, type UploadItem, type UploaderStore${kind === "resume" ? ", indexedDBPersistence" : ""} } from '@salyra-ui/file-uploader';
import { ${http ? "httpTransport" : "chunkedTransport"} } from '@salyra-ui/file-uploader/${http ? "http" : "chunked"}';
`;
}

function optionsSource(kind: string) {
  const http = kind === "http" || kind === "indeterminate";
  return `const options = {
  transport: ${http ? `httpTransport({ url: '/api/files', formField: 'file', progress: ${kind !== "indeterminate"} })` : "chunkedTransport({ baseURL: '/uploads' })"},
  chunkSize: 256 * 1024,
  autoUpload: false,
  maxConcurrentFiles: 2,
  maxConcurrentChunks: ${kind === "parallel" ? 3 : 1},
  maxConcurrentRequests: 4,
  retry: { maxAttempts: 4, baseDelay: 1000 },
${kind === "resume" ? "  persistence: indexedDBPersistence('my-app:authenticated-user'),\n" : ""}${kind === "limits" ? "  accept: 'image/*',\n  maxFileSize: 2 * 1024 * 1024,\n  maxFiles: 3,\n" : ""}};`;
}

/** Each tab contains the composition plus the selected behavior, using public exports. */
export function snippet(language: string, kind: string): string {
  if (
    language === "Astro" &&
    ["resume", "gallery", "retry", "limits"].includes(kind)
  )
    return astroClientRecipe(kind);
  let source = composition(language, kind);
  if (
    language === "Astro" &&
    ["http", "indeterminate", "limits"].includes(kind)
  ) {
    source = source.replace(
      "endpoint: '/uploads', chunkSize: 262144, maxConcurrentChunks: 1",
      kind === "limits"
        ? "endpoint: '/uploads', chunkSize: 262144, accept: 'image/*', maxFileSize: 2097152, maxFiles: 3"
        : "endpoint: '/api/files', transport: 'http', formField: 'file', progress: " +
            (kind !== "indeterminate"),
    );
  }
  const actions = ["retry", "cancel", "reset", "remove", "forget"];
  if (language === "React")
    source = source.replace(
      '            <FileUploader.Action action="resume">Resume</FileUploader.Action>',
      '            <FileUploader.Action action="resume">Resume</FileUploader.Action>\n' +
        actions
          .map(
            (action) =>
              `            <FileUploader.Action action="${action}">${action[0].toUpperCase() + action.slice(1)}</FileUploader.Action>`,
          )
          .join("\n"),
    );
  if (["Vue", "Svelte", "Astro"].includes(language))
    source = source.replace(
      '<FileUploader.Action action="resume">Resume</FileUploader.Action>',
      '<FileUploader.Action action="resume">Resume</FileUploader.Action>\n' +
        actions
          .map(
            (action) =>
              `          <FileUploader.Action action="${action}">${action[0].toUpperCase() + action.slice(1)}</FileUploader.Action>`,
          )
          .join("\n"),
    );
  if (language === "Angular")
    source = source.replace(
      '<button type="button" uploadAction="resume">Resume</button>',
      '<button type="button" uploadAction="resume">Resume</button>\n' +
        actions
          .map(
            (action) =>
              `            <button type="button" uploadAction="${action}">${action[0].toUpperCase() + action.slice(1)}</button>`,
          )
          .join("\n"),
    );
  if (language === "Vanilla")
    source = source.replace(
      '<button type="button" data-upload-action="resume">Resume</button>',
      '<button type="button" data-upload-action="resume">Resume</button>\n' +
        actions
          .map(
            (action) =>
              `      <button type="button" data-upload-action="${action}">${action[0].toUpperCase() + action.slice(1)}</button>`,
          )
          .join("\n"),
    );
  if (kind === "gallery") source = gallery(source, language);
  if (kind === "resume") source = resume(source, language);
  if (kind === "limits") source = limits(source, language);
  if (kind === "indeterminate")
    source = source
      .replaceAll(
        "Math.round(item.progress ?? 0)",
        "item.progress === null ? 'Sending' : Math.round(item.progress) + '%'",
      )
      .replaceAll("}%</span>", "}</span>")
      .replaceAll("}%{/snippet}", "}{/snippet}")
      .replaceAll("}}%", "}}");
  if (kind === "history") {
    source = history(source, language);
    source = source.replace(
      "const options = {",
      "const options = {\n" + historyOptions,
    );
    return source;
  }
  const recipe = featureRecipe(kind);
  // Application helpers are independent from the component's framework.
  // Attach them to the store through the APIs shown after the composition.
  if (!recipe) return source;
  if (language === "Svelte" || language === "Vue")
    return source.replace("</script>", "\n" + recipe + "\n</script>");
  if (language === "Astro")
    return (
      source +
      "\n<!-- Rich callbacks use a client-script Vanilla mount, documented in Customization. -->"
    );
  return source + "\n\n" + recipe;
}

function gallery(source: string, language: string) {
  if (language === "React")
    return source.replace(
      "            <FileUploader.Name />",
      `<FileUploader.Preview>
              {({ item, url }) => item.metadata.type.startsWith('image/') && url
                ? <img src={url} alt={item.metadata.name} className="file-thumbnail" />
                : item.metadata.type.startsWith('video/') && url
                  ? <video src={url} controls className="file-thumbnail" />
                  : <span className="file-format">{item.metadata.type || 'Document'}</span>}
            </FileUploader.Preview>
            <FileUploader.Name />`,
    );
  if (language === "Vue")
    return source.replace(
      "        <FileUploader.Name />",
      `<FileUploader.Preview v-slot="{ item, url }">
          <img v-if="item.metadata.type.startsWith('image/') && url" :src="url" :alt="item.metadata.name" class="file-thumbnail" />
          <video v-else-if="item.metadata.type.startsWith('video/') && url" :src="url" controls class="file-thumbnail" />
          <span v-else class="file-format">{{ item.metadata.type || 'Document' }}</span>
        </FileUploader.Preview>
        <FileUploader.Name />`,
    );
  if (language === "Svelte")
    return source.replace(
      "          <FileUploader.Name />",
      `<FileUploader.Preview>
            {#snippet children({ item, url })}
              {#if item.metadata.type.startsWith('image/') && url}
                <img src={url} alt={item.metadata.name} class="file-thumbnail" />
              {:else if item.metadata.type.startsWith('video/') && url}
                <video src={url} controls class="file-thumbnail"><track kind="captions" /></video>
              {:else}<span class="file-format">{item.metadata.type || 'Document'}</span>{/if}
            {/snippet}
          </FileUploader.Preview>
          <FileUploader.Name />`,
    );
  if (language === "Angular")
    return source
      .replace(
        "FileUploader.Name, FileUploader.Progress",
        "FileUploader.Name, FileUploader.Preview, FileUploader.Progress",
      )
      .replace(
        "            <span uploadName></span>",
        `<div uploadPreview #preview="uploadPreview">
              @if (file.value()?.metadata?.type?.startsWith('image/') && preview.url) {
                <img [src]="preview.url" [alt]="file.value()?.metadata?.name" class="file-thumbnail" />
              } @else if (file.value()?.metadata?.type?.startsWith('video/') && preview.url) {
                <video [src]="preview.url" controls class="file-thumbnail"></video>
              } @else { <span>{{ file.value()?.metadata?.type || 'Document' }}</span> }
            </div>
            <span uploadName></span>`,
      );
  if (language === "Vanilla")
    return source
      .replace(
        "<span data-upload-name></span>",
        "<div data-upload-preview></div>\n      <span data-upload-name></span>",
      )
      .replace(
        "  renderMetadata: item =>",
        `  renderPreview(element, item, url) {
    if (url && (item.metadata.type.startsWith('image/') || item.metadata.type.startsWith('video/'))) {
      const media = document.createElement(item.metadata.type.startsWith('image/') ? 'img' : 'video');
      media.src = url;
      media.className = 'file-thumbnail';
      if (media instanceof HTMLImageElement) media.alt = item.metadata.name;
      else media.controls = true;
      const current = element.firstElementChild;
      if (current?.tagName !== media.tagName || current.getAttribute('src') !== url) element.replaceChildren(media);
    } else element.textContent = item.metadata.type || 'Document';
  },
  renderMetadata: item =>`,
      );
  return source;
}

export function featureRecipe(kind: string) {
  switch (kind) {
    case "resume":
      return `// Reselecting a restored record needs its ID and the original File.
// React: useUploaderStore() inside Root. Vue/Svelte: useUploaderStore()
// during child setup. Angular: inject(Root).store. Vanilla: mounted.store.
// Astro: mount Vanilla in your client script for callbacks and persistence.
async function selectOriginal(store: UploaderStore, id: string, input: HTMLInputElement) {
  const file = input.files?.[0];
  if (!file) return;
  await store.attach(id, file); // Verifies saved SHA-256 receipts.
  store.resume(id);
  input.value = '';
}
// Bind to your file input's change event. Show it for awaiting-file rows.
// Match persistence namespaces to the signed-in user. Do not store credentials.`;
    case "retry":
      return `// The test endpoint belongs to this example's server.
async function rejectNextRequest() {
  await fetch('/demo/fail-next', { method: 'POST', headers: { 'X-Demo-Example': 'retry' } });
}
// Render this value from a clock updated every 250 ms while the row is mounted.
function retryLabel(item: UploadItem, now = Date.now()) {
  if (item.status !== 'retrying' || !item.nextRetryAt) return '';
  const seconds = Math.max(0, Math.ceil((item.nextRetryAt - now) / 1000));
  return 'Retrying in ' + seconds + 's';
}
// Subscribe per row, clear its interval on unmount and use Action cancel
// to stop both the request and the retry timer.`;
    case "parallel":
      return `// Confirmed parts can arrive in any order. Keep their real indexes.
function savedParts(item: UploadItem) {
  return new Set(item.parts.map(part => part.index));
}
// Render one block per part for a small file, grouping blocks for a large one.
// Always use uploadedBytes for saved data, transferredBytes for current progress.
function progressLabel(item: UploadItem) {
  return formatBytes(item.uploadedBytes) + ' saved / ' + formatBytes(item.totalBytes)
    + (item.etaSeconds === null ? '' : ' · about ' + Math.ceil(item.etaSeconds) + 's left');
}`;
    case "indeterminate":
      return `// progress is null when the transport cannot measure the request.
// Do not convert null into 0%. Progress leaves aria-valuenow unset.
function progressLabel(item: UploadItem) {
  return item.progress === null ? 'Sending' : Math.round(item.progress) + '%';
}
// Use a status label or an animated indicator, with reduced-motion support.`;
    case "limits":
      return `// Change options from your own buttons, switches or inputs.
// Get the store from the framework context or mounted.store in Vanilla.
function setDisabled(store: UploaderStore, checked: boolean) { store.setOptions({ disabled: checked }); }
function setReadOnly(store: UploaderStore, checked: boolean) { store.setOptions({ readOnly: checked }); }
// Both block selection/actions. Neither cancels a transfer already running.
// A native disabled attribute can disable an individual Trigger or Action.`;
    case "gallery":
      return `// You own .file-thumbnail and .file-format, including their size and layout.
// Preview creates and revokes object URLs. It does not parse PDFs or documents.
// In Astro, use a client-script mountUploader renderPreview callback for custom media.`;
    case "history":
      return `import { createUploader } from '@salyra-ui/file-uploader';
import { chunkedTransport } from '@salyra-ui/file-uploader/chunked';

const store = createUploader({
  transport: chunkedTransport({ baseURL: '/uploads' }),
  loadHistory: async cursor => {
    const response = await fetch('/api/files' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    if (!response.ok) throw new Error('Could not load files');
    return response.json(); // { items: ExistingUpload[], nextCursor?: string }
  },
  onRemove: async item => {
    const result = item.result as { id: string };
    const response = await fetch('/api/files/' + encodeURIComponent(result.id), { method: 'DELETE' });
    if (!response.ok) throw new Error('Could not remove the file');
  },
});
await store.loadHistory(); // Append the returned page, without duplicating IDs.
// Render these rows with the same Item components. Remove calls onRemove.
// Removal errors stay in item.removeError. Forget only clears the local row.`;
    default:
      return "";
  }
}

function resume(source: string, language: string) {
  if (language === "React") {
    return (
      source
        .replace(
          "import { FileUploader }",
          "import { FileUploader, useUploaderStore, useUploadItem }",
        )
        .replace(
          "<FileUploader.Name />",
          "<FileUploader.Name />\n            <OriginalFile />",
        ) +
      `

function OriginalFile() {
  const store = useUploaderStore();
  const item = useUploadItem();
  if (item?.status !== 'awaiting-file') return null;
  return <label>Select original file
    <input type="file" onChange={event => void selectOriginal(store, item.id, event.currentTarget)} />
  </label>;
}`
    );
  }
  if (language === "Vue")
    return source
      .replace(
        "import { FileUploader }",
        "import { onUnmounted } from 'vue';\nimport { FileUploader }",
      )
      .replace(
        "</script>",
        "const store = createUploader(options);\nonUnmounted(() => store.destroy());\n</script>",
      )
      .replace(':options="options"', ':store="store"')
      .replace(':id="id">', ':id="id" v-slot="{ item }">')
      .replace(
        "<FileUploader.Name />",
        `<FileUploader.Name />
        <label v-if="item.status === 'awaiting-file'">Select original file
          <input type="file" @change="selectOriginal(store, id, $event.currentTarget as HTMLInputElement)" />
        </label>`,
      );
  if (language === "Svelte")
    return source
      .replace(
        "import { FileUploader }",
        "import { onDestroy } from 'svelte';\nimport { FileUploader }",
      )
      .replace(
        "</script>",
        "const store = createUploader(options);\nonDestroy(() => store.destroy());\n</script>",
      )
      .replace("<FileUploader.Root {options}>", "<FileUploader.Root {store}>")
      .replace(
        "<FileUploader.Item {id}>",
        "<FileUploader.Item {id}>\n          {#snippet children(item)}",
      )
      .replace(
        "</FileUploader.Item>",
        "{/snippet}\n        </FileUploader.Item>",
      )
      .replace(
        "<FileUploader.Name />",
        `<FileUploader.Name />
          {#if item.status === 'awaiting-file'}
            <label>Select original file
              <input type="file" onchange={event => selectOriginal(store, id, event.currentTarget)} />
            </label>
          {/if}`,
      );
  if (language === "Angular")
    return source
      .replace('[uploadRoot]="options"', '[uploadRoot]="store"')
      .replace(
        "<span uploadName></span>",
        `<span uploadName></span>
            @if (file.value()?.status === 'awaiting-file') {
              <label>Select original file
                <input type="file" #original (change)="reselect(id, original)" />
              </label>
            }`,
      )
      .replace(
        "readonly options = options;",
        `readonly store = createUploader(options);
  reselect(id: string, input: HTMLInputElement) { return selectOriginal(this.store, id, input); }
  ngOnDestroy() { this.store.destroy(); }`,
      );
  if (language === "Vanilla")
    return source
      .replace(
        "<span data-upload-name></span>",
        `<span data-upload-name></span>
      <label data-original-label>Select original file <input type="file" data-original /></label>`,
      )
      .replace(
        "    return element;",
        `    const input = element.querySelector<HTMLInputElement>('[data-original]')!;
    input.addEventListener('change', () => void selectOriginal(mounted.store, item.id, input));
    return element;`,
      )
      .replace(
        "  renderMetadata: item =>",
        `  renderStatus: item => item.status,
  renderMetadata: item =>`,
      )
      .replace(
        "    element.textContent = item.progress",
        `    const row = element.closest('[data-upload-id]')!;
    (row.querySelector('[data-original-label]') as HTMLElement).hidden = item.status !== 'awaiting-file';
    element.textContent = item.progress`,
      );
  return source;
}

function astroClientRecipe(kind: string): string {
  const vanilla = snippet("Vanilla", kind);
  const match = vanilla.match(/\/\* Markup\n([\s\S]*?)\n\*\//);
  if (!match) throw new Error("The Vanilla recipe must include its HTML");
  const script = vanilla
    .replace(match[0], "")
    .replace(
      "document.querySelector('#uploader')",
      "document.querySelector<HTMLElement>('#uploader')!",
    );
  const markup = match[1]
    .replace(
      '<div data-upload-dropzone class="upload-zone">',
      '<FileUploader.Dropzone class="upload-zone">',
    )
    .replace(
      '<input type="file" multiple data-upload-input aria-label="Select files" />',
      '<FileUploader.Input multiple aria-label="Select files" />',
    )
    .replace(
      '<button type="button" data-upload-trigger>Select files</button>',
      "<FileUploader.Trigger>Select files</FileUploader.Trigger>",
    )
    .replace("  </div>", "  </FileUploader.Dropzone>")
    .replace(
      '<button type="button" data-upload-start>Upload</button>',
      '<FileUploader.Action action="start">Upload</FileUploader.Action>',
    )
    .replace("<ul data-upload-list></ul>", "<FileUploader.List />");
  return `---
import { FileUploader } from '@salyra-ui/file-uploader/astro';
---
<!-- Custom callbacks/persistence use a client mount. This section owns that store. -->
${markup}
<script>
${script}
// Clean up on an Astro navigation before mounting the next page.
document.addEventListener('astro:before-swap', () => mounted.destroy(), { once: true });
</script>`;
}

function limits(source: string, language: string) {
  if (language === "React")
    return (
      source
        .replace(
          "import { FileUploader }",
          "import { FileUploader, useUploaderStore }",
        )
        .replace(
          "<FileUploader.Root options={options}>",
          "<FileUploader.Root options={options}>\n      <SelectionControls />",
        ) +
      `

function SelectionControls() {
  const store = useUploaderStore();
  return <fieldset>
    <legend>Interaction</legend>
    <label><input type="checkbox" onChange={event => store.setOptions({ disabled: event.currentTarget.checked })} /> Disabled</label>
    <label><input type="checkbox" onChange={event => store.setOptions({ readOnly: event.currentTarget.checked })} /> Read-only</label>
  </fieldset>;
}`
    );
  if (language === "Vue")
    return source
      .replace(
        "import { FileUploader }",
        "import { onUnmounted } from 'vue';\nimport { FileUploader }",
      )
      .replace(
        "</script>",
        "const store = createUploader(options);\nonUnmounted(() => store.destroy());\n</script>",
      )
      .replace(
        '<FileUploader.Root :options="options">',
        `<FileUploader.Root :store="store">
    <label><input type="checkbox" @change="setDisabled(store, ($event.currentTarget as HTMLInputElement).checked)" /> Disabled</label>
    <label><input type="checkbox" @change="setReadOnly(store, ($event.currentTarget as HTMLInputElement).checked)" /> Read-only</label>`,
      );
  if (language === "Svelte")
    return source
      .replace(
        "import { FileUploader }",
        "import { onDestroy } from 'svelte';\nimport { FileUploader }",
      )
      .replace(
        "</script>",
        "const store = createUploader(options);\nonDestroy(() => store.destroy());\n</script>",
      )
      .replace(
        "<FileUploader.Root {options}>",
        `<FileUploader.Root {store}>
  <label><input type="checkbox" onchange={event => setDisabled(store, event.currentTarget.checked)} /> Disabled</label>
  <label><input type="checkbox" onchange={event => setReadOnly(store, event.currentTarget.checked)} /> Read-only</label>`,
      );
  if (language === "Angular")
    return source
      .replace(
        '<section [uploadRoot]="options">',
        `<section [uploadRoot]="store">
      <label><input type="checkbox" #disabledOption (change)="store.setOptions({ disabled: disabledOption.checked })" /> Disabled</label>
      <label><input type="checkbox" #readOnlyOption (change)="store.setOptions({ readOnly: readOnlyOption.checked })" /> Read-only</label>`,
      )
      .replace(
        "readonly options = options;",
        "readonly store = createUploader(options);\n  ngOnDestroy() { this.store.destroy(); }",
      );
  if (language === "Vanilla")
    return source
      .replace(
        '<section id="uploader">',
        `<section id="uploader">
  <label><input type="checkbox" data-disabled /> Disabled</label>
  <label><input type="checkbox" data-readonly /> Read-only</label>`,
      )
      .replace(
        "// TypeScript module.",
        `for (const [selector, key] of [['[data-disabled]', 'disabled'], ['[data-readonly]', 'readOnly']] as const) {
  document.querySelector<HTMLInputElement>(selector)!.addEventListener('change', event => {
    mounted.store.setOptions({ [key]: (event.currentTarget as HTMLInputElement).checked });
  });
}
// TypeScript module.`,
      );
  return source;
}

const historyOptions = `  loadHistory: async (cursor: string | undefined, signal: AbortSignal) => {
    const response = await fetch('/api/files' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { signal });
    if (!response.ok) throw new Error('Could not load uploaded files');
    return response.json(); // { items: ExistingUpload[], nextCursor?: string }
  },
  onRemove: async (item: UploadItem) => {
    const result = item.result as { id: string };
    const response = await fetch('/api/files/' + encodeURIComponent(result.id), { method: 'DELETE' });
    if (!response.ok) throw new Error('Could not remove the file');
  },
`;

function history(source: string, language: string) {
  if (language === "React")
    return (
      source
        .replace(
          "import { FileUploader }",
          "import { useState } from 'react';\nimport { FileUploader, useUploaderStore }",
        )
        .replace(
          "<FileUploader.Root options={options}>",
          "<FileUploader.Root options={options}>\n      <HistoryControls />",
        ) +
      `

function HistoryControls() {
  const store = useUploaderStore();
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState('');
  async function load(next?: string) {
    try { setCursor(await store.loadHistory(next)); setError(''); }
    catch (value) { setError(value instanceof Error ? value.message : 'Could not load files'); }
  }
  return <div>
    <button type="button" onClick={() => void load()}>Load uploaded files</button>
    <button type="button" disabled={!cursor} onClick={() => void load(cursor)}>Load more</button>
    <p role="status">{error}</p>
  </div>;
}`
    );
  if (language === "Vue")
    return source
      .replace(
        "import { FileUploader }",
        "import { ref, onUnmounted } from 'vue';\nimport { FileUploader }",
      )
      .replace(
        "</script>",
        `const store = createUploader(options);
const cursor = ref<string>(); const historyError = ref('');
async function load(next?: string) {
  try { cursor.value = await store.loadHistory(next); historyError.value = ''; }
  catch (value) { historyError.value = value instanceof Error ? value.message : 'Could not load files'; }
}
onUnmounted(() => store.destroy());
</script>`,
      )
      .replace(
        '<FileUploader.Root :options="options">',
        `<FileUploader.Root :store="store">
    <button type="button" @click="load()">Load uploaded files</button>
    <button type="button" :disabled="!cursor" @click="load(cursor)">Load more</button>
    <p role="status">{{ historyError }}</p>`,
      );
  if (language === "Svelte")
    return source
      .replace(
        "import { FileUploader }",
        "import { onDestroy } from 'svelte';\nimport { FileUploader }",
      )
      .replace(
        "</script>",
        `const store = createUploader(options);
let cursor = $state<string>(); let historyError = $state('');
async function load(next?: string) {
  try { cursor = await store.loadHistory(next); historyError = ''; }
  catch (value) { historyError = value instanceof Error ? value.message : 'Could not load files'; }
}
onDestroy(() => store.destroy());
</script>`,
      )
      .replace(
        "<FileUploader.Root {options}>",
        `<FileUploader.Root {store}>
  <button type="button" onclick={() => load()}>Load uploaded files</button>
  <button type="button" disabled={!cursor} onclick={() => load(cursor)}>Load more</button>
  <p role="status">{historyError}</p>`,
      );
  if (language === "Angular")
    return source
      .replace("import { Component }", "import { Component, signal }")
      .replace(
        '<section [uploadRoot]="options">',
        `<section [uploadRoot]="store">
      <button type="button" (click)="load()">Load uploaded files</button>
      <button type="button" [disabled]="!cursor()" (click)="load(cursor())">Load more</button>
      <p role="status">{{ historyError() }}</p>`,
      )
      .replace(
        "readonly options = options;",
        `readonly store = createUploader(options);
  readonly cursor = signal<string | undefined>(undefined);
  readonly historyError = signal('');
  async load(next?: string) {
    try { this.cursor.set(await this.store.loadHistory(next)); this.historyError.set(''); }
    catch (value) { this.historyError.set(value instanceof Error ? value.message : 'Could not load files'); }
  }
  ngOnDestroy() { this.store.destroy(); }`,
      );
  if (language === "Vanilla")
    return source
      .replace(
        '<section id="uploader">',
        `<section id="uploader">
  <button type="button" data-load-history>Load uploaded files</button>
  <button type="button" data-load-more disabled>Load more</button>
  <p role="status" data-history-error></p>`,
      )
      .replace(
        "// TypeScript module.",
        `let cursor: string | undefined;
const next = document.querySelector<HTMLButtonElement>('[data-load-more]')!;
const error = document.querySelector<HTMLElement>('[data-history-error]')!;
async function load(after?: string) {
  try { cursor = await mounted.store.loadHistory(after); next.disabled = !cursor; error.textContent = ''; }
  catch (value) { error.textContent = value instanceof Error ? value.message : 'Could not load files'; }
}
document.querySelector('[data-load-history]')!.addEventListener('click', () => void load());
next.addEventListener('click', () => void load(cursor));
// TypeScript module.`,
      );
  return source;
}
