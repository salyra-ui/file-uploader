# Salyra UI File Uploader

Composable file uploads for React, Svelte, Vue, Angular, Astro and Vanilla. The engine handles the queue, retry, pause, cancel, reset and verified chunked resume. Your markup controls the interface.

```sh
npm install @salyra-ui/file-uploader
```

```tsx
import { FileUploader } from "@salyra-ui/file-uploader/react";
import { chunkedTransport } from "@salyra-ui/file-uploader/chunked";

const options = { transport: chunkedTransport({ baseURL: "/uploads" }) };

export function UploadFiles() {
  return (
    <FileUploader.Root options={options}>
      <FileUploader.Input multiple aria-label="Select files" />
      <FileUploader.Action action="start">Upload</FileUploader.Action>
      <FileUploader.List>
        {(ids) =>
          ids.map((id) => (
            <FileUploader.Item key={id} id={id}>
              <FileUploader.Name />
              <FileUploader.Progress aria-label="Upload progress">
                {(item) => <span>{Math.round(item.progress ?? 0)}%</span>}
              </FileUploader.Progress>
              <FileUploader.Action action="pause">Pause</FileUploader.Action>
              <FileUploader.Action action="resume">Resume</FileUploader.Action>
            </FileUploader.Item>
          ))
        }
      </FileUploader.List>
    </FileUploader.Root>
  );
}
```

Imports use `/react`, `/svelte`, `/vue`, `/angular`, `/astro` or `/vanilla`. Only the selected adapter and its shared engine enter the application bundle. Framework peers are optional.

CSS is optional. The package does not install global styles automatically. Import `@salyra-ui/file-uploader/styles.css` for the optional minified composition styles, or use your own classes. Vanilla also provides standard and minified browser assets.

Use `httpTransport` for a single request. It retries from the beginning. Use `chunkedTransport` with a compatible server for verified resume. Backend code is distributed separately.

Pause keeps the session for Resume. Cancel stops the transfer and cleans up the old session when a cleanup handler is available. Retry starts a canceled file again from the beginning, with a new session. For single-request HTTP, provide `onCancel` when your endpoint needs a separate cleanup request.

[Documentation](https://salyra-ui.github.io/docs/file-uploader.html) · [Server integration](https://salyra-ui.github.io/docs/upload-server.html)
