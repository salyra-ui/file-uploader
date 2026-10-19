import { defineConfig } from "astro/config";
export default defineConfig({
  outDir: "../../../artifacts/frameworks/astro",
  base: "/frameworks/astro/",
  build: { format: "directory" },
  vite: { resolve: { dedupe: ["svelte"] } },
});
