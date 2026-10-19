import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer as createVite } from "vite";
import {
  createUploadServer,
  createUploadRouter,
} from "../packages/upload-server/src";
import {
  filesystemSessionStore,
  filesystemStorage,
} from "../packages/upload-server/src/storage/filesystem";
const sessions = filesystemSessionStore(".uploads/sessions"),
  storage = filesystemStorage(".uploads/storage");
const engine = createUploadServer({ allowAnonymous: true,
  sessionStore: sessions,
  storage,
  maxFileSize: 128 * 1024 * 1024,
});
const route = createUploadRouter(engine);
const vite = await createVite({
  server: { middlewareMode: true, host: "127.0.0.1" },
  appType: "spa",
});
const failNext = new Set<string>();
const server = createServer(async (request, response) => {
  if (request.url?.startsWith("/frameworks/") && !request.url.includes("..")) {
    try {
      let path = request.url.split("?")[0].slice(1);
      if (path.endsWith("/")) path += "index.html";
      if (!extname(path)) path += "/index.html";
      const bytes = await readFile(`artifacts/${path}`);
      response.setHeader(
        "Content-Type",
        path.endsWith(".js")
          ? "application/javascript"
          : path.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
    return;
  }
  if (request.method === "POST" && request.url === "/demo/http") {
    await mkdir(".uploads/http", { recursive: true });
    const path = `.uploads/http/${randomUUID()}`;
    const file = await open(path, "wx");
    let size = 0;
    const hash = createHash("sha256");
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024)
          throw new Error("This HTTP example accepts files up to 32 MiB");
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      await file.close();
      const descriptor = {
        protocol: "salyra-upload/1" as const,
        name: decodeURIComponent(
          String(request.headers["x-file-name"] ?? "document"),
        ),
        type: String(request.headers["x-file-type"] ?? ""),
        lastModified: Number(request.headers["x-file-modified"] ?? 0),
        size,
        chunkSize: Math.max(1, size),
      };
      const session = await engine.createUpload(
        descriptor,
        String(request.headers["idempotency-key"] ?? randomUUID()),
      );
      if ((await engine.getUpload(session.id)).status !== "completed")
        await engine.receivePart(
          session.id,
          0,
          hash.digest("hex"),
          createReadStream(path),
        );
      const result = await engine.finishUpload(session.id);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(result));
    } catch (error) {
      await file.close().catch(() => {});
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          message: error instanceof Error ? error.message : "Upload failed",
        }),
      );
    } finally {
      await unlink(path).catch(() => {});
    }
    return;
  }
  if (request.method === "POST" && request.url === "/demo/fail-next") {
    failNext.add(String(request.headers["x-demo-example"] ?? "retry"));
    response.end("{}");
    return;
  }
  if (request.method === "PUT" && request.url?.startsWith("/uploads/")) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (failNext.has(String(request.headers["x-demo-example"]))) {
      failNext.delete(String(request.headers["x-demo-example"]));
      response.writeHead(503, {
        "Content-Type": "application/json",
        "Retry-After": "2",
      });
      response.end(
        JSON.stringify({ message: "Demo: one upload request was rejected" }),
      );
      return;
    }
  }
  if (request.url === "/demo/history" && request.method === "GET") {
    const items = [];
    for await (const session of sessions.list()) {
      if (session.state !== "completed") continue;
      try {
        await access(`.uploads/storage/files/${session.id}`);
      } catch {
        continue;
      }
      items.push({
        id: session.id,
        metadata: { ...session.descriptor },
        result: session.result,
      });
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(items));
    return;
  }
  if (request.url === "/demo/fail-next-remove" && request.method === "POST") {
    failNext.add("remove");
    response.end("{}");
    return;
  }
  const final = /^\/demo\/files\/([a-zA-Z0-9_-]+)$/.exec(request.url ?? "");
  if (final && request.method === "DELETE") {
    if (failNext.delete("remove")) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end("{}");
      return;
    }
    const session = await sessions.get(final[1]);
    if (!session || session.state !== "completed") {
      response.writeHead(404);
      response.end();
      return;
    }
    await storage.remove?.({ id: final[1] }, undefined);
    response.end("{}");
    return;
  }
  if (final && request.method === "GET") {
    const session = await sessions.get(final[1]);
    if (!session || session.state !== "completed") {
      response.writeHead(404);
      response.end();
      return;
    }
    const path = `.uploads/storage/files/${final[1]}`;
    try {
      await access(path);
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/octet-stream");
    const stream = createReadStream(path);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
    return;
  }
  if (await route(request, response)) return;
  vite.middlewares(request, response, () => {
    response.writeHead(404);
    response.end();
  });
});
server.listen(4334, "127.0.0.1", () =>
  console.log("File Uploader: http://127.0.0.1:4334"),
);
function shutdown() {
  server.close();
  void vite.close().then(() => process.exit());
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
