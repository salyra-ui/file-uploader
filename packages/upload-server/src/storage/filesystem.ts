import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
  open,
  stat,
  symlink,
  readlink,
  unlink,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import type {
  ServerSession,
  SessionStore,
  StorageAdapter,
  StoredPart,
} from "../types";
import { UploadServerError } from "../types";
const safe = (id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new UploadServerError(400, "ID", "Invalid upload identifier");
  return id;
};
async function atomicJSON(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}
// A lock names its owner as "<pid>:<instance>". The instance is random per process start, so a
// lock left by an earlier run with the same PID (PID 1 in every container restart) is recognised
// as stale instead of looking alive forever.
const INSTANCE = randomUUID();
/** Persistent sessions with OS-backed directory exclusion. No stale-lock stealing while another process may be alive. */
export function filesystemSessionStore(directory: string): SessionStore {
  const root = resolve(directory);
  const file = (id: string) => join(root, `${safe(id)}.json`);
  async function get(id: string) {
    try {
      return JSON.parse(await readFile(file(id), "utf8")) as ServerSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  return {
    async transaction(key, operation) {
      await mkdir(root, { recursive: true });
      const lock = join(
        root,
        `${createHash("sha256").update(key).digest("hex")}.lock`,
      );
      const deadline = Date.now() + 30000;
      while (true) {
        try {
          await symlink(`${process.pid}:${INSTANCE}`, lock);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          // A lock from a dead local process can be reclaimed. Shared network filesystems need a database lease adapter.
          const recovery = `${lock}.recovery`;
          try {
            await mkdir(recovery);
            try {
              const [owner, instance] = (await readlink(lock)).split(":");
              const pid = Number(owner);
              if (pid === process.pid) {
                // this PID is ours: the lock is live only if this very process start took it
                if (instance !== INSTANCE) await unlink(lock);
              } else {
                try {
                  process.kill(pid, 0);
                } catch (cause) {
                  if ((cause as NodeJS.ErrnoException).code === "ESRCH")
                    await unlink(lock);
                }
              }
            } finally {
              await rm(recovery, { recursive: true, force: true });
            }
          } catch {}

          if (Date.now() > deadline)
            throw new UploadServerError(503, "BUSY", "Upload session is busy");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      try {
        return await operation();
      } finally {
        await unlink(lock);
      }
    },
    get,
    async remove(id) {
      await rm(file(id), { force: true });
    },
    async put(value) {
      await mkdir(root, { recursive: true });
      await atomicJSON(file(value.id), value);
    },
    async *list() {
      await mkdir(root, { recursive: true });
      for (const name of await readdir(root))
        if (name.endsWith(".json")) {
          const value = await get(name.slice(0, -5));
          if (value) yield value;
        }
    },
  };
}
/** Use a directory outside the web root. Original file names never become paths. */
export function filesystemStorage(directory: string): StorageAdapter {
  const root = resolve(directory);
  const sessionDir = (session: Pick<ServerSession, "id">) =>
    join(root, "parts", safe(session.id));
  const resultPath = (session: Pick<ServerSession, "id">) =>
    join(root, "files", safe(session.id));
  const partPath = (session: Pick<ServerSession, "id">, index: number) =>
    join(sessionDir(session), String(index));
  async function measure(path: string) {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(path)) {
      size += chunk.length;
      hash.update(chunk);
    }
    return { size, sha256: hash.digest("hex") };
  }
  return {
    capabilities: {
      minChunkSize: 1,
      maxChunkSize: 64 * 1024 * 1024,
      maxParts: 100000,
      parallelParts: true,
    },
    async begin(session) {
      await mkdir(sessionDir(session), { recursive: true });
      return { version: 1, id: session.id };
    },
    async writePart(session, part, body) {
      const target = partPath(session, part.index),
        temp = `${target}.${randomUUID()}.tmp`;
      try {
        let existing: { size: number; sha256: string };
        try {
          existing = JSON.parse(
            await readFile(`${target}.receipt.json`, "utf8"),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          existing = await measure(target);
        }
        if (existing.size !== part.size || existing.sha256 !== part.sha256)
          throw new UploadServerError(
            409,
            "PART_CONFLICT",
            "This chunk already contains different data",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const hash = createHash("sha256");
      let size = 0;
      const validator = new Transform({
        transform(chunk, _, callback) {
          size += chunk.length;
          if (size > part.size) {
            callback(
              new UploadServerError(
                413,
                "PART_SIZE",
                "Chunk exceeds its expected size",
              ),
            );
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          body,
          validator,
          createWriteStream(temp, { flags: "wx" }),
        );
        if (size !== part.size || hash.digest("hex") !== part.sha256)
          throw new UploadServerError(
            422,
            "CHECKSUM",
            "Chunk size or checksum does not match",
          );
        const handle = await open(temp, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, target);
        await atomicJSON(`${target}.receipt.json`, part);
        return { ...part, reference: { version: 1, index: part.index } };
      } finally {
        await rm(temp, { force: true });
      }
    },
    async probe(session) {
      const receipts: StoredPart[] = [];
      try {
        for (const name of await readdir(sessionDir(session)))
          if (/^\d+$/.test(name)) {
            const index = Number(name),
              path = partPath(session, index);
            let measured: { size: number; sha256: string };
            try {
              measured = JSON.parse(
                await readFile(`${path}.receipt.json`, "utf8"),
              );
              if ((await stat(path)).size !== measured.size)
                throw new Error("Stored part changed");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
              measured = await measure(path);
              await atomicJSON(`${path}.receipt.json`, { index, ...measured });
            }
            receipts.push({
              index,
              ...measured,
              reference: { version: 1, index },
            });
          }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return receipts.sort((a, b) => a.index - b.index);
    },
    async inspectResult(session) {
      try {
        // the receipt written at finish spares hashing the whole file on every probe
        const saved = await readFile(`${resultPath(session)}.json`, "utf8")
          .then((text) => JSON.parse(text) as { size: number; sha256: string })
          .catch(() => undefined);
        const measured =
          saved &&
          (await stat(resultPath(session))).size === saved.size &&
          /^[a-f0-9]{64}$/.test(saved.sha256)
            ? saved
            : await measure(resultPath(session));
        if (measured.size !== session.descriptor.size)
          throw new UploadServerError(
            500,
            "RESULT_SIZE",
            "Completed file has an invalid size",
          );
        return {
          found: true,
          result: {
            id: session.id,
            size: measured.size,
            sha256: measured.sha256,
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { found: false };
        throw error;
      }
    },
    async finish(session, parts) {
      const existing = await this.inspectResult(session, undefined);
      if (existing.found) return existing.result;
      await mkdir(join(root, "files"), { recursive: true });
      const target = resultPath(session),
        temp = `${target}.${randomUUID()}.tmp`;
      const output = await open(temp, "wx");
      let total = 0;
      const hash = createHash("sha256");
      try {
        for (const part of parts) {
          const partHash = createHash("sha256");
          let size = 0;
          for await (const chunk of createReadStream(
            partPath(session, part.index),
          )) {
            size += chunk.length;
            partHash.update(chunk);
            hash.update(chunk);
            let written = 0;
            while (written < chunk.length) {
              const result = await output.write(
                chunk,
                written,
                chunk.length - written,
              );
              written += result.bytesWritten;
            }
          }
          if (size !== part.size || partHash.digest("hex") !== part.sha256)
            throw new UploadServerError(
              422,
              "CHECKSUM",
              "Saved chunk failed verification",
            );
          total += size;
        }
        if (total !== session.descriptor.size)
          throw new UploadServerError(
            422,
            "SIZE",
            "Assembled file size does not match",
          );
        await output.sync();
        await output.close();
        await rename(temp, target);
        const sha256 = hash.digest("hex");
        await atomicJSON(`${target}.json`, { size: total, sha256 });
        await rm(sessionDir(session), { recursive: true, force: true });
        return { id: session.id, size: total, sha256 };
      } catch (error) {
        await output.close().catch(() => {});
        await rm(temp, { force: true });
        throw error;
      }
    },
    async abort(session) {
      await rm(sessionDir(session), { recursive: true, force: true });
    },
    async remove(result) {
      const target = resultPath({ id: (result as { id: string }).id });
      await rm(target, { force: true });
      await rm(`${target}.json`, { force: true });
    },
  };
}

/**
 * Use with S3/R2 on one host. One file per chunk receipt and one for the multipart reference:
 * chunks of one upload are received side by side, so no write rewrites another's record. A
 * ledger from an earlier version (one <id>.json) is still read.
 */
export function filesystemReceiptJournal(
  directory: string,
): import("../types").ReceiptJournal {
  const root = resolve(directory);
  type Ledger = {
    reference?: import("../types").MultipartReference;
    parts: StoredPart[];
  };
  const folder = (id: string) => join(root, safe(id));
  const legacy = (id: string) => join(root, `${safe(id)}.json`);
  async function readJSON<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  return {
    async get(id) {
      const parts = new Map<number, StoredPart>();
      for (const part of (await readJSON<Ledger>(legacy(id)))?.parts ?? [])
        parts.set(part.index, part);
      let names: string[] = [];
      try {
        names = await readdir(folder(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const name of names)
        if (/^\d+\.json$/.test(name)) {
          const part = await readJSON<StoredPart>(join(folder(id), name));
          if (part) parts.set(part.index, part);
        }
      return [...parts.values()].sort((a, b) => a.index - b.index);
    },
    async put(id, part) {
      if (!Number.isSafeInteger(part.index) || part.index < 0)
        throw new UploadServerError(400, "PART", "Invalid chunk number");
      await mkdir(folder(id), { recursive: true });
      await atomicJSON(join(folder(id), `${part.index}.json`), part);
    },
    async getReference(id) {
      return (
        (await readJSON<import("../types").MultipartReference>(
          join(folder(id), "reference.json"),
        )) ?? (await readJSON<Ledger>(legacy(id)))?.reference
      );
    },
    async putReference(id, reference) {
      await mkdir(folder(id), { recursive: true });
      await atomicJSON(join(folder(id), "reference.json"), reference);
    },
    async remove(id) {
      await rm(folder(id), { recursive: true, force: true });
      await rm(legacy(id), { force: true });
    },
  };
}
