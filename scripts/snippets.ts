import { snippet, languages } from "../examples/snippets";
import { parse } from "@babel/parser";
import { compile } from "svelte/compiler";
import { transform } from "@astrojs/compiler";
import { parse as parseVue, compileTemplate } from "@vue/compiler-sfc";
import { mkdir, writeFile } from "node:fs/promises";
const examples = [
  "http",
  "chunked",
  "resume",
  "retry",
  "parallel",
  "indeterminate",
  "gallery",
  "limits",
  "history",
];
await mkdir("artifacts/snippets", { recursive: true });
for (const language of languages)
  for (const example of examples) {
    const code = snippet(language, example);
    const name = `${language.toLowerCase()}-${example}`;
    try {
      if (language === "Svelte") {
        const result = compile(code, {
          filename: name + ".svelte",
          generate: "server",
        });
        if (result.warnings.length)
          throw new Error(
            result.warnings.map((value) => value.message).join("\n"),
          );
        await writeFile(`artifacts/snippets/${name}.svelte`, code);
      } else if (language === "Vue") {
        const { descriptor, errors } = parseVue(code);
        if (errors.length) throw errors[0];
        parse(descriptor.scriptSetup!.content, {
          sourceType: "module",
          plugins: ["typescript"],
        });
        const template = compileTemplate({
          source: descriptor.template!.content,
          filename: name + ".vue",
          id: name,
        });
        if (template.errors.length) throw template.errors[0];
      } else if (language === "Astro") {
        const result = await transform(code, { filename: name + ".astro" });
        if (result.diagnostics?.some((value) => value.severity === 1))
          throw new Error(JSON.stringify(result.diagnostics));
      } else {
        parse(code, {
          sourceType: "module",
          plugins: [
            "typescript",
            ...(language === "React" ? ["jsx" as const] : []),
            ...(language === "Angular" ? ["decorators-legacy" as const] : []),
          ],
        });
      }
    } catch (error) {
      throw new Error(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
console.log(
  `All ${languages.length * examples.length} public example snippets parse or compile in their framework.`,
);
