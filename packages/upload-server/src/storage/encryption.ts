import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  UploadServerError,
  type StorageAdapter,
  type ServerSession,
  type StoredPart,
} from "../types";

export type EncryptionKeyMaterial = Uint8Array | KeyObject;
export interface EncryptionKey {
  id: string;
  key: EncryptionKeyMaterial;
}
export interface EncryptionKeyring {
  /** Called only for a new session. Retain old keys until their uploads are removed. */
  current(context: unknown): EncryptionKey | Promise<EncryptionKey>;
  resolve(
    id: string,
    context: unknown,
  ):
    | EncryptionKeyMaterial
    | undefined
    | Promise<EncryptionKeyMaterial | undefined>;
}
export interface EncryptedFilesystemOptions {
  directory: string;
  keys: EncryptionKeyring;
}
export interface EncryptedUploadResult {
  id: string;
  size: number;
  sha256: string;
  encryption: { format: typeof FORMAT; keyId: string };
}
export interface EncryptedFilesystemStorage extends StorageAdapter {
  /** Authorize in your application before calling read. Each frame is authenticated before it is returned. */
  read(id: string, context?: unknown): Promise<Readable>;
}
const FORMAT = "salyra-aes256gcm/1" as const;
/** Receipt files seal the plaintext SHA-256 of a part. Format 1 receipts held it in clear, with a MAC. */
const RECEIPT_FORMAT = "salyra-receipt/2" as const;
const FRAME = 64 * 1024;
const MAGIC = Buffer.from("SLYRAE01");
const MAX_CHUNK = 64 * 1024 * 1024;
interface Reference {
  format: typeof FORMAT;
  id: string;
  keyId: string;
  salt: string;
  size: number;
  chunkSize: number;
}
const failure = (code: string, message: string) =>
  new UploadServerError(500, code, message);
const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
function safeId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw failure("STORAGE_REFERENCE", "Invalid storage ID");
  return id;
}
function validate(value: unknown): Reference {
  const ref = value as Reference;
  if (
    !ref ||
    ref.format !== FORMAT ||
    typeof ref.id !== "string" ||
    typeof ref.keyId !== "string" ||
    !ref.keyId.trim() ||
    ref.keyId.length > 128 ||
    typeof ref.salt !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(ref.salt) ||
    Buffer.from(ref.salt, "base64").toString("base64") !== ref.salt ||
    !Number.isSafeInteger(ref.size) ||
    ref.size < 0 ||
    !Number.isSafeInteger(ref.chunkSize) ||
    ref.chunkSize < 1 ||
    ref.chunkSize > MAX_CHUNK ||
    Math.ceil(ref.size / ref.chunkSize) > 10000
  )
    throw failure("STORAGE_REFERENCE", "Invalid encrypted storage reference");
  safeId(ref.id);
  return {
    format: FORMAT,
    id: ref.id,
    keyId: ref.keyId,
    salt: ref.salt,
    size: ref.size,
    chunkSize: ref.chunkSize,
  };
}
function reference(session: ServerSession): Reference {
  const ref = validate(session.storageRef);
  if (
    ref.id !== session.id ||
    ref.size !== session.descriptor.size ||
    ref.chunkSize !== session.descriptor.chunkSize
  )
    throw failure(
      "STORAGE_REFERENCE",
      "Encrypted reference does not match the session",
    );
  return ref;
}
function material(value: EncryptionKeyMaterial | undefined): Buffer {
  if (!value)
    throw failure(
      "ENCRYPTION_KEY_MISSING",
      "The encryption key is unavailable",
    );
  let bytes: Buffer;
  if (value instanceof Uint8Array) bytes = Buffer.from(value);
  else if (value.type === "secret") bytes = Buffer.from(value.export());
  else
    throw failure("ENCRYPTION_KEY", "Encryption requires a 32-byte secret key");
  if (bytes.length !== 32) {
    bytes.fill(0);
    throw failure("ENCRYPTION_KEY", "Encryption requires a 32-byte secret key");
  }
  return bytes;
}
function fileKey(ref: Reference, master: Buffer): Buffer {
  try {
    return Buffer.from(
      hkdfSync(
        "sha256",
        master,
        Buffer.from(ref.salt, "base64"),
        `salyra/storage/1/${ref.id}`,
        32,
      ),
    );
  } finally {
    master.fill(0);
  }
}
function partKey(key: Buffer, salt: Buffer, index: number) {
  return Buffer.from(
    hkdfSync("sha256", key, salt, `salyra/part/1/${index}`, 32),
  );
}
function nonce(index: number) {
  const iv = Buffer.alloc(12);
  iv.writeUInt32BE(index, 8);
  return iv;
}
function aad(ref: Reference, part: number, frame: number, length: number) {
  return Buffer.from(
    JSON.stringify([
      FORMAT,
      ref.id,
      ref.keyId,
      ref.salt,
      ref.size,
      ref.chunkSize,
      part,
      frame,
      length,
    ]),
  );
}
function partSize(ref: Reference, index: number) {
  const count = Math.max(1, Math.ceil(ref.size / ref.chunkSize));
  if (!Number.isInteger(index) || index < 0 || index >= count)
    throw failure("PART_INDEX", "Invalid encrypted part index");
  return Math.min(ref.chunkSize, Math.max(0, ref.size - index * ref.chunkSize));
}
/** A key of its own for receipts: the file key also keys the part keys and the format 1 receipt MAC. */
function receiptKey(key: Buffer) {
  return Buffer.from(
    hkdfSync("sha256", key, Buffer.alloc(0), "salyra/receipt-key/2", 32),
  );
}
function receiptAad(ref: Reference, index: number, size: number) {
  return Buffer.from(
    JSON.stringify([
      RECEIPT_FORMAT,
      ref.id,
      ref.keyId,
      ref.salt,
      ref.size,
      ref.chunkSize,
      index,
      size,
    ]),
  );
}
interface SealedReceipt {
  format: typeof RECEIPT_FORMAT;
  index: number;
  size: number;
  /** base64 of nonce (12 bytes), encrypted SHA-256 (32) and GCM tag (16). */
  sealed: string;
}
/** AES-256-GCM with a fresh random nonce. The AAD binds the format, session, key, part index and size. */
function sealReceipt(
  part: StoredPart,
  ref: Reference,
  key: Buffer,
): SealedReceipt {
  if (!/^[a-f0-9]{64}$/.test(part.sha256))
    throw failure("STORAGE_RECEIPT", "Invalid part checksum");
  const derived = receiptKey(key),
    iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", derived, iv);
    cipher.setAAD(receiptAad(ref, part.index, part.size));
    const sealed = Buffer.concat([
      iv,
      cipher.update(Buffer.from(part.sha256, "hex")),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      format: RECEIPT_FORMAT,
      index: part.index,
      size: part.size,
      sealed: sealed.toString("base64"),
    };
  } finally {
    derived.fill(0);
  }
}
/** Returns the plaintext SHA-256 of the part, or fails authentication. */
function openReceipt(
  saved: Partial<SealedReceipt>,
  ref: Reference,
  index: number,
  key: Buffer,
): string {
  const invalid = () =>
    failure("ENCRYPTION_AUTH", "Encrypted receipt failed authentication");
  if (
    saved.index !== index ||
    saved.size !== partSize(ref, index) ||
    typeof saved.sealed !== "string" ||
    !/^[A-Za-z0-9+/]{80}$/.test(saved.sealed)
  )
    throw invalid();
  const bytes = Buffer.from(saved.sealed, "base64"),
    derived = receiptKey(key);
  try {
    const cipher = createDecipheriv(
      "aes-256-gcm",
      derived,
      bytes.subarray(0, 12),
    );
    cipher.setAAD(receiptAad(ref, index, saved.size));
    cipher.setAuthTag(bytes.subarray(44));
    return Buffer.concat([
      cipher.update(bytes.subarray(12, 44)),
      cipher.final(),
    ]).toString("hex");
  } catch {
    throw invalid();
  } finally {
    derived.fill(0);
  }
}
/** A committed upload needs no receipts: reading it authenticates its chunks by decrypting them. Dropping them leaves no part digest at rest, including receipts that format 1 wrote in clear. Best effort: what cannot be removed stays harmless. */
async function dropReceipts(folder: string) {
  try {
    for (const name of await readdir(folder))
      if (/^(0|[1-9]\d*)\.json$/.test(name))
        await rm(join(folder, name), { force: true });
  } catch {}
}
async function writeAll(handle: FileHandle, data: Buffer) {
  let offset = 0;
  while (offset < data.length) {
    const written = await handle.write(data, offset, data.length - offset);
    if (!written.bytesWritten)
      throw failure("STORAGE_WRITE", "Could not write encrypted data");
    offset += written.bytesWritten;
  }
}
async function atomicJson(target: string, value: unknown) {
  const temporary = `${target}-${randomBytes(16).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await writeAll(handle, Buffer.from(JSON.stringify(value)));
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}
async function readExact(handle: FileHandle, length: number): Promise<Buffer> {
  const data = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(data, offset, length - offset, null);
    if (!read.bytesRead)
      throw failure("ENCRYPTION_AUTH", "Encrypted data is truncated");
    offset += read.bytesRead;
  }
  return data;
}
/** Fixed-size frames keep memory bounded and prevent plaintext being emitted before GCM tag validation. */
async function* decode(
  path: string,
  ref: Reference,
  index: number,
  key: Buffer,
): AsyncGenerator<Buffer> {
  const handle = await open(path, "r");
  let derived: Buffer | undefined;
  try {
    const header = await readExact(handle, 40);
    if (!header.subarray(0, 8).equals(MAGIC))
      throw failure("ENCRYPTION_AUTH", "Unrecognized encrypted data");
    derived = partKey(key, header.subarray(8), index);
    let remaining = partSize(ref, index),
      frame = 0;
    do {
      const length = Math.min(FRAME, remaining),
        encoded = await readExact(handle, length + 16);
      const cipher = createDecipheriv("aes-256-gcm", derived, nonce(frame));
      cipher.setAAD(aad(ref, index, frame, length));
      cipher.setAuthTag(encoded.subarray(length));
      let plain: Buffer;
      try {
        plain = Buffer.concat([
          cipher.update(encoded.subarray(0, length)),
          cipher.final(),
        ]);
      } catch {
        throw failure(
          "ENCRYPTION_AUTH",
          "Encrypted data failed authentication",
        );
      }
      if (plain.length) yield plain;
      remaining -= length;
      frame++;
    } while (remaining > 0);
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, null)).bytesRead)
      throw failure(
        "ENCRYPTION_AUTH",
        "Encrypted data has unexpected trailing bytes",
      );
  } finally {
    derived?.fill(0);
    await handle.close();
  }
}
async function receipt(
  path: string,
  ref: Reference,
  index: number,
  key: Buffer,
  total?: ReturnType<typeof createHash>,
): Promise<StoredPart> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const bytes of decode(path, ref, index, key)) {
    size += bytes.length;
    hash.update(bytes);
    total?.update(bytes);
  }
  return {
    index,
    size,
    sha256: hash.digest("hex"),
    reference: { format: FORMAT, index },
  };
}
async function validateBody(
  body: Readable,
  part: Omit<StoredPart, "reference">,
  consume: (data: Buffer) => Promise<void>,
) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const incoming of body) {
    const bytes = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
    size += bytes.length;
    if (size > part.size)
      throw new UploadServerError(
        413,
        "PART_SIZE",
        "Chunk exceeds the expected size",
      );
    hash.update(bytes);
    await consume(bytes);
  }
  if (size !== part.size || hash.digest("hex") !== part.sha256)
    throw new UploadServerError(
      422,
      "CHECKSUM",
      "Chunk size or checksum does not match",
    );
}
/** Private directory storage. Committed uploads remain encrypted part containers and read() assembles them as a stream. */
export function encryptedFilesystemStorage(
  options: EncryptedFilesystemOptions,
): EncryptedFilesystemStorage {
  const root = resolve(options.directory);
  const directory = (group: "parts" | "files", id: string) =>
    join(root, group, safeId(id));
  const pathFor = (folder: string, index: number) =>
    join(folder, `${index}.enc`);
  const keyFor = async (ref: Reference, context: unknown) =>
    fileKey(ref, material(await options.keys.resolve(ref.keyId, context)));
  async function load(folder: string) {
    const manifestPath = join(folder, "reference.json");
    if ((await stat(manifestPath)).size > 4096)
      throw failure(
        "STORAGE_REFERENCE",
        "Encrypted storage reference is too large",
      );
    const json = await readFile(manifestPath);
    if (json.length > 4096)
      throw failure(
        "STORAGE_REFERENCE",
        "Encrypted storage reference is too large",
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(json.toString());
    } catch {
      throw failure("STORAGE_REFERENCE", "Invalid encrypted storage reference");
    }
    return validate(parsed);
  }
  /** Format 1 receipts: the plaintext digest in clear, authenticated by an HMAC under the file key. */
  const legacyReceiptMac = (part: StoredPart, ref: Reference, key: Buffer) =>
    createHmac("sha256", key)
      .update(
        JSON.stringify([
          "salyra/receipt/1",
          ref.id,
          ref.keyId,
          ref.salt,
          ref.size,
          ref.chunkSize,
          part.index,
          part.size,
          part.sha256,
        ]),
      )
      .digest();
  async function saveReceipt(
    folder: string,
    ref: Reference,
    part: StoredPart,
    key: Buffer,
  ) {
    await atomicJson(
      join(folder, `${part.index}.json`),
      sealReceipt(part, ref, key),
    );
  }

  async function savedReceipt(
    folder: string,
    ref: Reference,
    index: number,
    key: Buffer,
  ) {
    const path = join(folder, `${index}.json`);
    try {
      if ((await stat(path)).size > 4096)
        throw failure("ENCRYPTION_AUTH", "Invalid encrypted receipt");
      let saved: StoredPart & { mac?: string; format?: string };
      try {
        saved = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (absent(error)) throw error;
        throw failure("ENCRYPTION_AUTH", "Invalid encrypted receipt");
      }
      const legacy = saved?.format !== RECEIPT_FORMAT;
      let sha256: string;
      if (!legacy)
        sha256 = openReceipt(
          saved as unknown as SealedReceipt,
          ref,
          index,
          key,
        );
      else {
        if (
          !saved ||
          saved.index !== index ||
          saved.size !== partSize(ref, index) ||
          !/^[a-f0-9]{64}$/.test(saved.sha256) ||
          typeof saved.mac !== "string" ||
          !/^[a-f0-9]{64}$/.test(saved.mac) ||
          !timingSafeEqual(
            legacyReceiptMac(saved, ref, key),
            Buffer.from(saved.mac, "hex"),
          )
        )
          throw failure(
            "ENCRYPTION_AUTH",
            "Encrypted receipt failed authentication",
          );
        sha256 = saved.sha256;
      }
      const frames = Math.max(1, Math.ceil(saved.size / FRAME));
      if (
        (await stat(pathFor(folder, index))).size !==
        40 + saved.size + frames * 16
      )
        throw failure("ENCRYPTION_AUTH", "Encrypted chunk size changed");
      const part: StoredPart = {
        index,
        size: saved.size,
        sha256,
        reference: { format: FORMAT, index },
      };
      // A verified format 1 receipt is rewritten sealed. Failing to is no reason to fail the read.
      if (legacy) await saveReceipt(folder, ref, part, key).catch(() => {});
      return part;
    } catch (error) {
      if (!absent(error)) throw error;
      const recovered = await receipt(pathFor(folder, index), ref, index, key);
      await saveReceipt(folder, ref, recovered, key);
      return recovered;
    }
  }
  async function result(
    folder: string,
    ref: Reference,
    context: unknown,
  ): Promise<EncryptedUploadResult> {
    const saved = await load(folder);
    if (JSON.stringify(saved) !== JSON.stringify(ref))
      throw failure(
        "STORAGE_REFERENCE",
        "Encrypted destination belongs to another session",
      );
    const key = await keyFor(ref, context),
      hash = createHash("sha256");
    try {
      for (let i = 0; i < Math.max(1, Math.ceil(ref.size / ref.chunkSize)); i++)
        await receipt(pathFor(folder, i), ref, i, key, hash);
      return {
        id: ref.id,
        size: ref.size,
        sha256: hash.digest("hex"),
        encryption: { format: FORMAT, keyId: ref.keyId },
      };
    } finally {
      key.fill(0);
    }
  }
  return {
    capabilities: {
      minChunkSize: 1,
      maxChunkSize: MAX_CHUNK,
      maxParts: 10000,
      parallelParts: true,
    },
    async begin(session, context) {
      const folder = directory("parts", session.id);
      try {
        const saved = await load(folder);
        if (
          saved.id !== session.id ||
          saved.size !== session.descriptor.size ||
          saved.chunkSize !== session.descriptor.chunkSize
        )
          throw failure(
            "STORAGE_REFERENCE",
            "Encrypted destination belongs to another session",
          );
        const key = await keyFor(saved, context);
        key.fill(0);
        return saved;
      } catch (error) {
        if (!absent(error)) throw error;
      }
      const current = await options.keys.current(context);
      const ref = validate({
        format: FORMAT,
        id: session.id,
        keyId: current.id,
        salt: randomBytes(32).toString("base64"),
        size: session.descriptor.size,
        chunkSize: session.descriptor.chunkSize,
      });
      const key = fileKey(ref, material(current.key));
      key.fill(0);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await atomicJson(join(folder, "reference.json"), ref);
      return ref;
    },
    async writePart(session, part, body, context) {
      const ref = reference(session);
      if (part.size !== partSize(ref, part.index))
        throw failure("PART_SIZE", "Invalid encrypted part size");
      const key = await keyFor(ref, context),
        folder = directory("parts", ref.id),
        target = pathFor(folder, part.index);
      try {
        let existing: StoredPart | undefined;
        try {
          existing = await savedReceipt(folder, ref, part.index, key);
        } catch (error) {
          if (!absent(error)) throw error;
        }
        if (existing) {
          if (existing.size !== part.size || existing.sha256 !== part.sha256)
            throw new UploadServerError(
              409,
              "PART_CONFLICT",
              "Chunk already contains different data",
            );
          await validateBody(body, part, async () => {});
          return existing;
        }
        const temporary = join(
          folder,
          `${part.index}-${randomBytes(16).toString("hex")}.tmp`,
        );
        const handle = await open(temporary, "wx", 0o600),
          salt = randomBytes(32),
          derived = partKey(key, salt, part.index);
        const buffer = Buffer.alloc(FRAME);
        let used = 0,
          frame = 0;
        const flush = async () => {
          const cipher = createCipheriv("aes-256-gcm", derived, nonce(frame));
          cipher.setAAD(aad(ref, part.index, frame, used));
          await writeAll(
            handle,
            Buffer.concat([
              cipher.update(buffer.subarray(0, used)),
              cipher.final(),
              cipher.getAuthTag(),
            ]),
          );
          used = 0;
          frame++;
        };
        try {
          await writeAll(handle, Buffer.concat([MAGIC, salt]));
          await validateBody(body, part, async (bytes) => {
            let offset = 0;
            while (offset < bytes.length) {
              const count = Math.min(FRAME - used, bytes.length - offset);
              bytes.copy(buffer, used, offset, offset + count);
              used += count;
              offset += count;
              if (used === FRAME) await flush();
            }
          });
          if (used || frame === 0) await flush();
          await handle.sync();
          await handle.close();
          await rename(temporary, target);
          await saveReceipt(
            folder,
            ref,
            { ...part, reference: { format: FORMAT, index: part.index } },
            key,
          );
          return { ...part, reference: { format: FORMAT, index: part.index } };
        } finally {
          derived.fill(0);
          buffer.fill(0);
          await handle.close();
          await rm(temporary, { force: true });
        }
      } finally {
        key.fill(0);
      }
    },
    async probe(session, context) {
      const ref = reference(session),
        folder = directory("parts", ref.id),
        key = await keyFor(ref, context);
      try {
        let names: string[];
        try {
          names = await readdir(folder);
        } catch (error) {
          if (absent(error)) return [];
          throw error;
        }
        const parts: StoredPart[] = [];
        for (const name of names.sort())
          if (/^(0|[1-9]\d*)\.enc$/.test(name)) {
            const index = Number(name.slice(0, -4));
            parts.push(await savedReceipt(folder, ref, index, key));
          }
        return parts.sort((a, b) => a.index - b.index);
      } finally {
        key.fill(0);
      }
    },
    async inspectResult(session, context) {
      const ref = reference(session),
        folder = directory("files", ref.id);
      try {
        await load(folder);
      } catch (error) {
        if (absent(error)) return { found: false };
        throw error;
      }
      await dropReceipts(folder);
      return { found: true, result: await result(folder, ref, context) };
    },
    async finish(session, parts, context) {
      const inspected = await this.inspectResult(session, context);
      if (inspected.found) return inspected.result;
      const ref = reference(session),
        folder = directory("parts", ref.id),
        key = await keyFor(ref, context),
        hash = createHash("sha256");
      try {
        const count = Math.max(1, Math.ceil(ref.size / ref.chunkSize));
        if (parts.length !== count)
          throw failure("PART_MISSING", "Encrypted upload is incomplete");
        for (let i = 0; i < count; i++) {
          const saved = await receipt(pathFor(folder, i), ref, i, key, hash),
            expected = parts.find((part) => part.index === i);
          if (
            !expected ||
            saved.sha256 !== expected.sha256 ||
            saved.size !== expected.size
          )
            throw failure(
              "ENCRYPTION_AUTH",
              "Encrypted chunk does not match its receipt",
            );
        }
        await mkdir(join(root, "files"), { recursive: true, mode: 0o700 });
        await rename(folder, directory("files", ref.id));
        await dropReceipts(directory("files", ref.id));
        return {
          id: ref.id,
          size: ref.size,
          sha256: hash.digest("hex"),
          encryption: { format: FORMAT, keyId: ref.keyId },
        } satisfies EncryptedUploadResult;
      } finally {
        key.fill(0);
      }
    },
    async abort(session) {
      await rm(directory("parts", session.id), {
        recursive: true,
        force: true,
      });
    },
    async remove(value) {
      const result = value as EncryptedUploadResult;
      await rm(directory("files", result.id), { recursive: true, force: true });
    },
    async read(id, context) {
      const folder = directory("files", id),
        ref = await load(folder);
      if (ref.id !== id)
        throw failure(
          "STORAGE_REFERENCE",
          "Encrypted destination belongs to another session",
        );
      await dropReceipts(folder);
      // Resolve inside the generator so destroying an unread stream cannot leave a derived key alive.
      async function* contents() {
        const key = await keyFor(ref, context);
        try {
          for (
            let i = 0;
            i < Math.max(1, Math.ceil(ref.size / ref.chunkSize));
            i++
          )
            yield* decode(pathFor(folder, i), ref, i, key);
        } finally {
          key.fill(0);
        }
      }
      return Readable.from(contents(), { objectMode: false });
    },
  };
}
