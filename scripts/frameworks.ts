import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { compile } from "svelte/compiler";
import { transform } from "@astrojs/compiler";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { createSSRApp, h } from "vue";
import { renderToString as renderVue } from "@vue/server-renderer";
import { FileUploader as ReactUploader } from "../packages/file-uploader/src/react";
import { FileUploader as VueUploader } from "../packages/file-uploader/src/vue";
import { httpTransport } from "../packages/file-uploader/src/transport/http";
const source = "packages/file-uploader/src";
for (const file of await readdir(`${source}/svelte`))
  if (file.endsWith(".svelte")) {
    const compiled = compile(
      await readFile(`${source}/svelte/${file}`, "utf8"),
      { filename: file, generate: "server" },
    );
    if (compiled.warnings.length)
      throw new Error(
        `${file}: ${compiled.warnings.map((w) => w.message).join(", ")}`,
      );
  }
for (const file of await readdir(`${source}/astro`))
  if (file.endsWith(".astro"))
    await transform(await readFile(`${source}/astro/${file}`, "utf8"), {
      filename: file,
    });
const options = {
  transport: httpTransport({ url: "/upload" }),
  initialFiles: [
    {
      id: "document",
      metadata: {
        name: "Saved document.pdf",
        size: 40,
        type: "application/pdf",
        lastModified: 0,
      },
    },
  ],
};
const react = renderToString(
  createElement(
    ReactUploader.Root,
    { options },
    createElement(ReactUploader.List, {
      children: (ids) =>
        ids.map((id) =>
          createElement(
            ReactUploader.Item,
            { id, key: id },
            createElement(ReactUploader.Name),
          ),
        ),
    }),
  ),
);
const vue = await renderVue(
  createSSRApp({
    render: () =>
      h(
        VueUploader.Root,
        { options },
        {
          default: () =>
            h(
              VueUploader.List,
              {},
              {
                default: ({ ids }: { ids: string[] }) =>
                  ids.map((id) =>
                    h(
                      VueUploader.Item,
                      { id },
                      { default: () => h(VueUploader.Name) },
                    ),
                  ),
              },
            ),
        },
      ),
  }),
);
if (
  !react.includes("Saved document.pdf") ||
  !vue.includes("Saved document.pdf")
)
  throw new Error("SSR did not render existing records");
const isolated = renderToString(
  createElement(
    ReactUploader.Root,
    { options: { transport: options.transport } },
    createElement(ReactUploader.List, { children: (ids) => ids.join(",") }),
  ),
);
if (isolated.includes("document"))
  throw new Error("SSR state leaked between trees");
console.log(
  "Svelte and Astro components compile. React and Vue SSR render existing records and isolate stores.",
);
