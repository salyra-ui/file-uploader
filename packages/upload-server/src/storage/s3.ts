export type { ReceiptJournal, MultipartReference as Reference } from "../types";
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  ServerSession,
  StoredPart,
  StorageAdapter,
  ReceiptJournal,
  MultipartReference as Reference,
} from "../types";
import { UploadServerError } from "../types";
export type S3Encryption =
  { mode: "AES256" } | { mode: "aws:kms"; keyId: string; bucketKey?: boolean };
export interface S3StorageOptions {
  client: S3Client;
  bucket: string;
  prefix?: string;
  journal: ReceiptJournal;
  provider?: "s3" | "r2";
  /** Applied when creating new objects. R2 manages encryption itself and does not accept these AWS options. */
  encryption?: S3Encryption;
  /**
   * The stored object's Content-Type. The descriptor's type comes from the browser, so it is not
   * trusted by default: objects are application/octet-stream, served as attachments. Return a
   * type here only after checking it (for example against an allowlist of image types).
   */
  contentType?(descriptor: ServerSession["descriptor"]): string | undefined;
}
const reference = (session: ServerSession) => session.storageRef as Reference;
const missing = (error: unknown) =>
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode === 404;
/** R2 uses the S3 SDK with a configured R2 endpoint. The supplied journal must be persistent. */
export function s3Storage(options: S3StorageOptions): StorageAdapter {
  const { client, journal, bucket } = options,
    checksums = options.provider !== "r2";
  if (options.encryption && options.provider === "r2")
    throw new TypeError(
      "R2 does not accept AWS server-side encryption options",
    );
  if (
    options.encryption &&
    !["AES256", "aws:kms"].includes(options.encryption.mode)
  )
    throw new TypeError("Unsupported S3 encryption mode");
  if (
    options.encryption?.mode === "aws:kms" &&
    options.encryption.bucketKey !== undefined &&
    typeof options.encryption.bucketKey !== "boolean"
  )
    throw new TypeError("S3 bucketKey must be a boolean");
  if (
    options.encryption?.mode === "aws:kms" &&
    (typeof options.encryption.keyId !== "string" ||
      !options.encryption.keyId.trim())
  )
    throw new TypeError("KMS encryption requires a key ID");
  const encryption =
    options.encryption?.mode === "aws:kms"
      ? {
          ServerSideEncryption: "aws:kms" as const,
          SSEKMSKeyId: options.encryption.keyId,
          BucketKeyEnabled: options.encryption.bucketKey,
        }
      : options.encryption
        ? { ServerSideEncryption: "AES256" as const }
        : {};
  const prefix = options.prefix ?? "uploads/",
    keyFor = (id: string) => `${prefix}${id}`;
  return {
    capabilities: {
      minChunkSize: 5 * 1024 * 1024,
      maxChunkSize: 5 * 1024 * 1024 * 1024,
      maxParts: 10000,
      parallelParts: true,
    },
    async begin(session) {
      const key = keyFor(session.id);
      const recovered = await journal.getReference(session.id);
      if (recovered) {
        if (recovered.bucket !== bucket || recovered.key !== key)
          throw new UploadServerError(
            409,
            "STORAGE_REFERENCE",
            "Session belongs to another storage destination",
          );
        return recovered;
      }
      if (!session.descriptor.size) {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: "",
            ...encryption,
            ContentType:
              options.contentType?.(session.descriptor) ||
              "application/octet-stream",
            ContentDisposition: "attachment",
            Metadata: { "salyra-session": session.id },
          }),
        );
        return { version: 1, bucket, key };
      }
      const created = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ...encryption,
          ContentType:
            options.contentType?.(session.descriptor) ||
            "application/octet-stream",
          ContentDisposition: "attachment",
          Metadata: { "salyra-session": session.id },
          ...(checksums ? { ChecksumAlgorithm: "SHA256" as const } : {}),
        }),
      );
      if (!created.UploadId)
        throw new UploadServerError(
          502,
          "MULTIPART_ID",
          "Provider did not return a multipart upload ID",
        );
      const reference: Reference = {
        version: 1,
        bucket,
        key,
        uploadId: created.UploadId,
      };
      await journal.putReference(session.id, reference);
      return reference;
    },
    async writePart(session, part, body) {
      const existing = (await journal.get(session.id)).find(
        (saved) => saved.index === part.index,
      );
      if (
        existing &&
        (existing.size !== part.size || existing.sha256 !== part.sha256)
      )
        throw new UploadServerError(
          409,
          "PART_CONFLICT",
          "Chunk already contains different data",
        );
      const ref = reference(session),
        hash = createHash("sha256");
      let size = 0;
      const validator = new Transform({
        transform(chunk, _, callback) {
          size += chunk.length;
          if (size > part.size) {
            callback(
              new UploadServerError(
                413,
                "PART_SIZE",
                "Chunk exceeds the expected size",
              ),
            );
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
        flush(callback) {
          if (size !== part.size || hash.digest("hex") !== part.sha256) {
            callback(
              new UploadServerError(
                422,
                "CHECKSUM",
                "Chunk size or checksum does not match",
              ),
            );
            return;
          }
          callback();
        },
      });
      const input = pipeline(body, validator);
      try {
        const saved = await client.send(
          new UploadPartCommand({
            Bucket: ref.bucket,
            Key: ref.key,
            UploadId: ref.uploadId,
            PartNumber: part.index + 1,
            Body: validator,
            ContentLength: part.size,
            ...(checksums
              ? {
                  ChecksumSHA256: Buffer.from(part.sha256, "hex").toString(
                    "base64",
                  ),
                }
              : {}),
          }),
        );
        await input;
        if (!saved.ETag)
          throw new UploadServerError(
            502,
            "PART_ETAG",
            "Provider did not return a part receipt",
          );
        const receipt = {
          ...part,
          reference: { version: 1, etag: saved.ETag },
        };
        await journal.put(session.id, receipt);
        return receipt;
      } catch (error) {
        validator.destroy(error as Error);
        await input.catch(() => {});
        throw error;
      }
    },
    async probe(session) {
      const ref = reference(session);
      if (!ref.uploadId) return [];
      const known = await journal.get(session.id),
        parts: StoredPart[] = [];
      let marker: string | undefined;
      do {
        const listed = await client.send(
          new ListPartsCommand({
            Bucket: ref.bucket,
            Key: ref.key,
            UploadId: ref.uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const remote of listed.Parts ?? []) {
          const saved = known.find(
            (part) =>
              part.index + 1 === remote.PartNumber &&
              (part.reference as { etag: string }).etag === remote.ETag,
          );
          // Parts without a trusted checksum/journal entry are safely sent again, never blindly skipped.
          if (saved && saved.size === remote.Size) parts.push(saved);
          else if (
            checksums &&
            remote.ChecksumSHA256 &&
            remote.PartNumber &&
            remote.Size !== undefined &&
            remote.ETag
          )
            parts.push({
              index: remote.PartNumber - 1,
              size: remote.Size,
              sha256: Buffer.from(remote.ChecksumSHA256, "base64").toString(
                "hex",
              ),
              reference: { version: 1, etag: remote.ETag },
            });
        }
        marker = listed.IsTruncated ? listed.NextPartNumberMarker : undefined;
        if (listed.IsTruncated && !marker)
          throw new UploadServerError(
            502,
            "PART_PAGINATION",
            "Provider returned an incomplete part listing",
          );
      } while (marker);
      return parts;
    },
    async inspectResult(session) {
      const ref = reference(session);
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: ref.bucket, Key: ref.key }),
        );
        if (
          result.Metadata?.["salyra-session"] !== session.id ||
          result.ContentLength !== session.descriptor.size
        )
          throw new UploadServerError(
            409,
            "OBJECT_CONFLICT",
            "Destination contains another object",
          );
        return {
          found: true,
          result: {
            id: session.id,
            bucket: ref.bucket,
            key: ref.key,
            size: result.ContentLength,
            etag: result.ETag,
          },
        };
      } catch (error) {
        if (missing(error)) return { found: false };
        throw error;
      }
    },
    async finish(session, parts) {
      const ref = reference(session),
        inspected = await this.inspectResult(session, undefined);
      if (inspected.found) return inspected.result;
      // The official SDK parses embedded XML errors even if the HTTP response status is 200.
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: ref.bucket,
          Key: ref.key,
          UploadId: ref.uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.index + 1,
              ETag: (part.reference as { etag: string }).etag,
              ...(checksums
                ? {
                    ChecksumSHA256: Buffer.from(part.sha256, "hex").toString(
                      "base64",
                    ),
                  }
                : {}),
            })),
          },
        }),
      );
      const completed = await this.inspectResult(session, undefined);
      if (!completed.found)
        throw new UploadServerError(
          502,
          "RESULT_MISSING",
          "Completed object could not be verified",
        );
      await journal.remove(session.id);
      return completed.result;
    },
    async abort(session) {
      const ref = reference(session);
      if (ref.uploadId) {
        try {
          await client.send(
            new AbortMultipartUploadCommand({
              Bucket: ref.bucket,
              Key: ref.key,
              UploadId: ref.uploadId,
            }),
          );
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      await journal.remove(session.id);
    },
    async remove(result) {
      const ref = result as { bucket: string; key: string };
      // the result may have travelled through the application: only this adapter's objects go
      if (
        !ref ||
        ref.bucket !== bucket ||
        typeof ref.key !== "string" ||
        !ref.key.startsWith(prefix) ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(ref.key.slice(prefix.length))
      )
        throw new UploadServerError(
          400,
          "STORAGE_REFERENCE",
          "This result does not belong to this storage",
        );
      await client.send(
        new DeleteObjectCommand({ Bucket: ref.bucket, Key: ref.key }),
      );
    },
  };
}
export function r2Storage(options: Omit<S3StorageOptions, "provider">) {
  return s3Storage({ ...options, provider: "r2" });
}
