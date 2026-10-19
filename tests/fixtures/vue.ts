import { createApp, h } from "vue";
import { FileUploader } from "../../packages/file-uploader/src/vue";
import { createUploader } from "../../packages/file-uploader/src/core";
import { chunkedTransport } from "../../packages/file-uploader/src/transport/chunked";
const store = createUploader({
  transport: chunkedTransport({ baseURL: "/uploads" }),
  chunkSize: 262144,
});
createApp({
  render: () =>
    h(
      FileUploader.Root,
      { store },
      {
        default: () => [
          h(FileUploader.Input, {
            "aria-label": "Select files",
            multiple: true,
          }),
          h(
            FileUploader.Action,
            { action: "start" },
            { default: () => "Upload" },
          ),
          h(
            FileUploader.Action,
            {
              action: "start",
              onClick: (event: Event) => event.preventDefault(),
            },
            { default: () => "Blocked upload" },
          ),
          h(
            FileUploader.Action,
            { action: "start", disabled: true },
            { default: () => "Disabled upload" },
          ),
          h(
            "button",
            { onClick: () => store.setOptions({ disabled: true }) },
            "Disable root",
          ),
          h(
            FileUploader.List,
            { as: "div" },
            {
              default: ({ ids }: { ids: string[] }) =>
                ids.map((id) =>
                  h(
                    FileUploader.Item,
                    { as: "article", id, key: id, class: "custom-row" },
                    {
                      default: () => [
                        h(FileUploader.Name),
                        h(FileUploader.Status),
                        h(
                          FileUploader.Action,
                          { action: "cancel" },
                          { default: () => "Cancel" },
                        ),
                        h(
                          FileUploader.Action,
                          { action: "retry" },
                          { default: () => "Retry" },
                        ),
                        h(
                          FileUploader.Progress,
                          { "aria-label": "Upload progress" },
                          {
                            default: ({ item }: any) =>
                              Math.round(item.progress ?? 0) + "%",
                          },
                        ),
                      ],
                    },
                  ),
                ),
            },
          ),
        ],
      },
    ),
}).mount("#app");
