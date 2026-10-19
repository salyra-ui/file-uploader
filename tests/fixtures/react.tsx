import React from "react";
import { createRoot } from "react-dom/client";
import {
  FileUploader,
  useUploaderStore,
} from "../../packages/file-uploader/src/react";
import { createUploader } from "../../packages/file-uploader/src/core";
import { chunkedTransport } from "../../packages/file-uploader/src/transport/chunked";
const store = createUploader({
  transport: chunkedTransport({ baseURL: "/uploads" }),
  chunkSize: 262144,
});
const App = () => (
  <FileUploader.Root store={store}>
    <FileUploader.Input aria-label="Select files" multiple />
    <FileUploader.Action action="start">Upload</FileUploader.Action>
    <FileUploader.Action
      action="start"
      onClick={(event) => event.preventDefault()}
    >
      Blocked upload
    </FileUploader.Action>
    <FileUploader.Action action="start" disabled>
      Disabled upload
    </FileUploader.Action>
    <button onClick={() => store.setOptions({ disabled: true })}>
      Disable root
    </button>
    <FileUploader.List as="div">
      {(ids) =>
        ids.map((id) => (
          <FileUploader.Item
            as="article"
            id={id}
            key={id}
            className="custom-row"
          >
            <FileUploader.Name />
            <FileUploader.Status />
            <FileUploader.Action action="cancel">Cancel</FileUploader.Action>
            <FileUploader.Action action="retry">Retry</FileUploader.Action>
            <FileUploader.Progress aria-label="Upload progress">
              {(item) =>
                item.progress === null
                  ? "Sending"
                  : Math.round(item.progress) + "%"
              }
            </FileUploader.Progress>
          </FileUploader.Item>
        ))
      }
    </FileUploader.List>
  </FileUploader.Root>
);
const lifecycleBorrowed = createUploader({
  transport: chunkedTransport({ baseURL: "/uploads" }),
});
const lifecycleOptions = {
  transport: chunkedTransport({ baseURL: "/uploads" }),
};
function RecordLifecycleStore() {
  const active = useUploaderStore();
  React.useEffect(() => {
    if (active !== lifecycleBorrowed) (window as any).__auditOwned = active;
    (window as any).__auditBorrowed = lifecycleBorrowed;
  }, [active]);
  return null;
}
function Lifecycle() {
  const [mode, setMode] = React.useState("owned");
  return (
    <section aria-label="Root lifecycle">
      <button onClick={() => setMode("borrowed")}>Replace owned store</button>
      <button onClick={() => setMode("none")}>Unmount borrowed root</button>
      {mode !== "none" && (
        <FileUploader.Root
          store={mode === "borrowed" ? lifecycleBorrowed : undefined}
          options={lifecycleOptions}
        >
          <RecordLifecycleStore />
        </FileUploader.Root>
      )}
    </section>
  );
}
createRoot(document.getElementById("app")!).render(
  <React.StrictMode>
    <App />
    <Lifecycle />
  </React.StrictMode>,
);
