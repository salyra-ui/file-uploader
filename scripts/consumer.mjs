import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const directory = await mkdtemp(join(tmpdir(), "salyra-upload-consumer-"));
const npm =
  process.env.SALYRA_NPM_CLI ?? resolve("node_modules/npm/bin/npm-cli.js");
const args = process.env.SALYRA_NPM_CLI ? [npm] : [];
function install(packages) {
  execFileSync(
    args.length ? process.execPath : "npm",
    [...args, "install", "--ignore-scripts", "--legacy-peer-deps", ...packages],
    { cwd: directory, stdio: "pipe" },
  );
}
try {
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  install([
    resolve("release/file-uploader/salyra-ui-file-uploader-0.1.0.tgz"),
    resolve("release/upload-server/salyra-ui-upload-server-0.1.0.tgz"),
    "typescript@~5.8.3",
    "@types/node@^22",
  ]);
  const source = `import { createUploader, formatBytes, uploadActions } from '@salyra-ui/file-uploader';\nimport { httpTransport } from '@salyra-ui/file-uploader/http';\nimport { chunkedTransport } from '@salyra-ui/file-uploader/chunked';\nimport { mountUploader } from '@salyra-ui/file-uploader/vanilla';\nimport { createUploadServer } from '@salyra-ui/upload-server';\nimport { encryptedFilesystemStorage } from '@salyra-ui/upload-server/encryption';\nconst encryptionKey = new Uint8Array(32);\nconst encrypted = encryptedFilesystemStorage({directory:'/tmp/consumer-encrypted',keys:{current:()=>({id:'consumer',key:encryptionKey}),resolve:()=>encryptionKey}});\nimport { filesystemSessionStore, filesystemStorage, filesystemReceiptJournal } from '@salyra-ui/upload-server/filesystem';\nconst uploader=createUploader({transport:httpTransport({url:'/upload'})});\nuploader.destroy();\nconst server=createUploadServer({allowAnonymous:true,sessionStore:filesystemSessionStore('/tmp/consumer-sessions'),storage:filesystemStorage('/tmp/consumer-content')});\nconsole.log(formatBytes(1024), server.capabilities.protocol);`;
  await writeFile(join(directory, "consumer.ts"), source);
  execFileSync(
    process.execPath,
    [
      join(directory, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--lib",
      "ES2022,DOM",
      "consumer.ts",
    ],
    { cwd: directory, stdio: "inherit" },
  );
  await writeFile(join(directory, "consumer.mjs"), source);
  execFileSync(process.execPath, ["consumer.mjs"], {
    cwd: directory,
    stdio: "inherit",
  });
  for (const dependency of [
    "react",
    "vue",
    "svelte",
    "@angular/core",
    "@aws-sdk/client-s3",
  ]) {
    try {
      await readFile(
        join(directory, "node_modules", dependency, "package.json"),
      );
      throw new Error(
        `Unrequested optional dependency was installed: ${dependency}`,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  install([
    "react@18.3.1",
    "react-dom@18.3.1",
    "@types/react@^18",
    "vue@^3.5",
    "@angular/core@~20.3.33",
    "rxjs@^7",
  ]);
  await writeFile(
    join(directory, "adapters.tsx"),
    `import { FileUploader as ReactUpload } from '@salyra-ui/file-uploader/react';
import { FileUploader as VueUpload } from '@salyra-ui/file-uploader/vue';
import { FileUploader as AngularUpload } from '@salyra-ui/file-uploader/angular';
import { httpTransport } from '@salyra-ui/file-uploader/http';
import { h } from 'vue';
const options = {transport:httpTransport({url:'/files'})};
const react = <ReactUpload.Root options={options}><ReactUpload.List>{ids=>ids.map(id=><ReactUpload.Item id={id} key={id}><ReactUpload.Metadata>{item=>item.metadata.name}</ReactUpload.Metadata></ReactUpload.Item>)}</ReactUpload.List></ReactUpload.Root>;
const vue = h(VueUpload.Root, {options});
const angular = AngularUpload.Root;
`,
  );
  execFileSync(
    process.execPath,
    [
      join(directory, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--jsx",
      "react-jsx",
      "--lib",
      "ES2022,DOM",
      "adapters.tsx",
    ],
    { cwd: directory, stdio: "inherit" },
  );
  console.log(
    "Fresh packages compile and run without framework or provider dependencies.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
