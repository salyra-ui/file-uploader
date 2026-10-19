import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { compile } from "svelte/compiler";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
for (const framework of ["react", "vue", "svelte", "angular"]) {
  const directory = `artifacts/frameworks/${framework}`;
  await mkdir(directory, { recursive: true });
  await build({
    entryPoints: [
      framework === "svelte"
        ? "tests/fixtures/svelte/main.ts"
        : `tests/fixtures/${framework}.${framework === "react" ? "tsx" : "ts"}`,
    ],
    outfile: `${directory}/app.js`,
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["browser"],
    sourcemap: false,
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "packed-uploader",
        setup(builder) {
          builder.onResolve(
            { filter: /packages\/file-uploader\/src\// },
            (args) => {
              const suffix = args.path.split("packages/file-uploader/src/")[1];
              const path = suffix.startsWith("transport/")
                ? suffix + ".js"
                : suffix + (suffix === "svelte" ? "/index.ts" : "/index.js");
              return { path: resolve("release/file-uploader/dist", path) };
            },
          );
        },
      },
      {
        name: "svelte",
        setup(builder) {
          builder.onLoad({ filter: /\.svelte$/ }, async (args) => {
            const result = compile(await readFile(args.path, "utf8"), {
              filename: args.path,
              generate: "client",
              dev: true,
            });
            return { contents: result.js.code, loader: "js" };
          });
        },
      },
    ],
  });
  await writeFile(
    `${directory}/index.html`,
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>${framework} uploader test</title></head><body><div id="app"></div>${framework === "angular" ? "<app-uploader-test></app-uploader-test>" : ""}<script type="module" src="./app.js"></script></body></html>`,
  );
}
execFileSync(
  process.execPath,
  [
    "node_modules/astro/bin/astro.mjs",
    "build",
    "--root",
    "tests/fixtures/astro",
  ],
  { stdio: "inherit", env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" } },
);
console.log(
  "Built browser fixtures for React, Vue, Svelte, Angular and Astro.",
);
