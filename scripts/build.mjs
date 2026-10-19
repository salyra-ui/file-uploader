import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parse } from "svelte/compiler";
import { transform as astroTransform } from "@astrojs/compiler";
async function compact(dir) {
  const { parse: parseJS } = await import("@babel/parser");
  const module = await import("@babel/generator"),
    generate = module.default.default ?? module.default;
  const script = (source) =>
    generate(
      parseJS(source, { sourceType: "module", plugins: ["typescript"] }),
      { minified: true, comments: false },
    ).code;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      await compact(path);
      continue;
    }
    if (entry.name.endsWith(".d.ts")) continue;
    let source = await readFile(path, "utf8");
    if (entry.name.endsWith(".ts")) source = script(source);
    else if (entry.name.endsWith(".svelte")) {
      const ast = parse(source, { modern: true });
      for (const block of [ast.instance, ast.module]
        .filter(Boolean)
        .sort((a, b) => b.content.start - a.content.start))
        source =
          source.slice(0, block.content.start) +
          script(source.slice(block.content.start, block.content.end)) +
          source.slice(block.content.end);
    } else if (entry.name.endsWith(".astro")) {
      source = source
        .replace(
          /^---\r?\n([\s\S]*?)\r?\n---/,
          (_, body) => `---\n${script(body)}\n---`,
        )
        .replace(
          /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g,
          (_, open, body, close) =>
            open +
            (open.includes('type="application/json"') ? body : script(body)) +
            close,
        );
      await astroTransform(source, { filename: path });
    } else continue;
    await writeFile(path, source.trim() + "\n");
  }
}
await rm("release", { recursive: true, force: true });
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  { stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [
    "node_modules/@angular/compiler-cli/bundles/src/bin/ngc.js",
    "-p",
    "tsconfig.angular.json",
  ],
  { stdio: "inherit" },
);
const root = "release/file-uploader";
await mkdir(`${root}/dist`, { recursive: true });
const entries = {
  "core/index": "packages/file-uploader/src/core/index.ts",
  "core/errors": "packages/file-uploader/src/core/errors.ts",
  "react/index": "packages/file-uploader/src/react/index.tsx",
  "vue/index": "packages/file-uploader/src/vue/index.ts",
  "vanilla/index": "packages/file-uploader/src/vanilla/index.ts",
  "angular/index": "artifacts/angular/angular/index.js",
  "transport/http": "packages/file-uploader/src/transport/http.ts",
  "transport/chunked": "packages/file-uploader/src/transport/chunked.ts",
};
await build({
  entryPoints: entries,
  outdir: `${root}/dist`,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "neutral",
  packages: "external",
  minify: true,
  sourcemap: false,
  target: "es2022",
  plugins: [
    {
      name: "shared-core",
      setup(b) {
        b.onResolve({ filter: /^\.\.\/core$/ }, () => ({
          path: resolve("packages/file-uploader/src/core/index.ts"),
        }));
      },
    },
  ],
});
await cp("artifacts/types/file-uploader/src", `${root}/dist`, {
  recursive: true,
});
for (const file of await readdir("artifacts/angular/angular"))
  if (file.endsWith(".d.ts"))
    await cp(
      `artifacts/angular/angular/${file}`,
      `${root}/dist/angular/${file}`,
    );
for (const dir of ["svelte", "astro"]) {
  await cp(`packages/file-uploader/src/${dir}`, `${root}/dist/${dir}`, {
    recursive: true,
  });
  for (const file of await readdir(`${root}/dist/${dir}`)) {
    const path = `${root}/dist/${dir}/${file}`,
      text = await readFile(path, "utf8");
    await writeFile(
      path,
      text
        .replace(/from (['"])\.\.\/core\1/g, 'from "../core/index.js"')
        .replace(/from (['"])\.\.\/vanilla\1/g, 'from "../vanilla/index.js"')
        .replace(
          /from (['"])\.\.\/transport\/chunked\1/g,
          'from "../transport/chunked.js"',
        )
        .replace(
          /from (['"])\.\.\/transport\/http\1/g,
          'from "../transport/http.js"',
        ),
    );
  }
  await compact(`${root}/dist/${dir}`);
}
for (const minify of [false, true]) {
  await build({
    entryPoints: ["packages/file-uploader/src/vanilla/browser.ts"],
    outfile: `${root}/dist/browser/file-uploader${minify ? ".min" : ""}.js`,
    bundle: true,
    format: "iife",
    globalName: "SalyraFileUploader",
    platform: "browser",
    minify,
    sourcemap: false,
    target: "es2022",
  });
  await build({
    entryPoints: ["packages/file-uploader/src/styles.css"],
    outfile: `${root}/dist/styles${minify ? ".min" : ""}.css`,
    minify,
    sourcemap: false,
  });
}
const manifest = JSON.parse(
  await readFile("packages/file-uploader/package.json", "utf8"),
);
delete manifest.private;
manifest.exports = {
  ".": { types: "./dist/core/index.d.ts", import: "./dist/core/index.js" },
  ...Object.fromEntries(
    ["react", "vue", "vanilla", "angular"].map((name) => [
      `./${name}`,
      { types: `./dist/${name}/index.d.ts`, import: `./dist/${name}/index.js` },
    ]),
  ),
  "./svelte": "./dist/svelte/index.ts",
  "./astro": "./dist/astro/index.ts",
  "./astro/*": "./dist/astro/*",
  ...Object.fromEntries(
    ["http", "chunked"].map((name) => [
      `./${name}`,
      {
        types: `./dist/transport/${name}.d.ts`,
        import: `./dist/transport/${name}.js`,
      },
    ]),
  ),
  "./styles.css": "./dist/styles.min.css",
  "./styles.min.css": "./dist/styles.min.css",
  "./styles.standard.css": "./dist/styles.css",
  "./browser/*": "./dist/browser/*",
};
await finish(root, manifest, "file-uploader");
const backend = "release/upload-server";
await mkdir(`${backend}/dist`, { recursive: true });
await build({
  entryPoints: {
    index: "packages/upload-server/src/index.ts",
    "storage/filesystem": "packages/upload-server/src/storage/filesystem.ts",
    "storage/s3": "packages/upload-server/src/storage/s3.ts",
    "storage/encryption": "packages/upload-server/src/storage/encryption.ts",
  },
  outdir: `${backend}/dist`,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  packages: "external",
  minify: true,
  sourcemap: false,
  target: "node22",
});
await cp("artifacts/types/upload-server/src", `${backend}/dist`, {
  recursive: true,
});
const backendManifest = JSON.parse(
  await readFile("packages/upload-server/package.json", "utf8"),
);
delete backendManifest.private;
backendManifest.exports = {
  ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
  ...Object.fromEntries(
    ["filesystem", "s3", "encryption"].map((name) => [
      `./${name}`,
      {
        types: `./dist/storage/${name}.d.ts`,
        import: `./dist/storage/${name}.js`,
      },
    ]),
  ),
};
await finish(backend, backendManifest, "upload-server");
async function finish(directory, manifest, slug) {
  await declarations(`${directory}/dist`);
  manifest.files = ["dist", "README.md", "LICENSE"];
  await writeFile(
    `${directory}/package.json`,
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await cp(`packages/${slug}/README.md`, `${directory}/README.md`);
  await cp("LICENSE", `${directory}/LICENSE`);
  const archive = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
      cwd: directory,
      encoding: "utf8",
    }),
  )[0];
  for (const file of archive.files) {
    if (
      file.path.endsWith(".map") ||
      (!file.path.startsWith("dist/") &&
        !["package.json", "README.md", "LICENSE"].includes(file.path))
    )
      throw new Error(`Unexpected archive file: ${file.path}`);
    if (
      /\.(js|css|ts|svelte|astro)$/.test(file.path) &&
      (await readFile(`${directory}/${file.path}`, "utf8")).includes(
        "sourceMappingURL",
      )
    )
      throw new Error(`Sourcemap reference: ${file.path}`);
  }
  console.log(
    `${archive.filename}: ${archive.size} bytes, ${archive.entryCount} files, dist-only and no sourcemaps`,
  );
}

async function declarations(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      await declarations(path);
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;
    let source = await readFile(path, "utf8");
    source = source.replace(
      /((?:from\s+|import\s*\()(['"]))([.][.\/][^'"]+)(\2)/g,
      (_, open, quote, specifier, close) =>
        open +
        (/\.(js|ts|svelte|astro)$/.test(specifier)
          ? specifier
          : specifier +
            (existsSync(resolve(dirname(path), specifier, "index.d.ts"))
              ? "/index.js"
              : ".js")) +
        close,
    );
    await writeFile(path, source);
  }
}
