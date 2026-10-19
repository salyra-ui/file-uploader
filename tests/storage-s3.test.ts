import { it, expect } from "vitest";
import { createServer } from "node:http";
import {
  S3Client,
  CompleteMultipartUploadCommand,
  UploadPartCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import {
  s3Storage,
  r2Storage,
  type Reference,
  type ReceiptJournal,
} from "../packages/upload-server/src/storage/s3";
import type { ServerSession, StoredPart } from "../packages/upload-server/src";
const session: ServerSession = {
  id: "test-session",
  key: "key",
  expiresAt: Date.now() + 10000,
  state: "open",
  parts: [],
  storageRef: {
    version: 1,
    bucket: "uploads",
    key: "test-session",
    uploadId: "multipart",
  },
  descriptor: {
    protocol: "salyra-upload/1",
    name: "test.txt",
    type: "text/plain",
    size: 4,
    lastModified: 0,
    chunkSize: 5 * 1024 * 1024,
  },
};
const hash = "88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589";
function journal(): ReceiptJournal {
  let parts: StoredPart[] = [],
    reference: Reference | undefined;
  return {
    async getReference() {
      return reference;
    },
    async putReference(_, value) {
      reference = value;
    },
    async get() {
      return parts;
    },
    async put(_, part) {
      parts = [...parts.filter((p) => p.index !== part.index), part];
    },
    async remove() {
      parts = [];
      reference = undefined;
    },
  };
}
it("uses the S3 SDK interpretation of an embedded error in an HTTP 200 completion", async () => {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(
      "<Error><Code>InternalError</Code><Message>Multipart completion failed</Message><RequestId>test</RequestId></Error>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new S3Client({
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: "local-test",
      secretAccessKey: "local-test-only",
    },
    maxAttempts: 1,
  });
  try {
    await expect(
      client.send(
        new CompleteMultipartUploadCommand({
          Bucket: "uploads",
          Key: "test-session",
          UploadId: "id",
          MultipartUpload: { Parts: [{ ETag: "opaque", PartNumber: 1 }] },
        }),
      ),
    ).rejects.toMatchObject({ name: "InternalError" });
  } finally {
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("keeps opaque ETags separate from digests and saves a durable receipt before returning it", async () => {
  const savedJournal = journal();
  const client = {
    async send(command: unknown) {
      if (command instanceof UploadPartCommand) {
        let value = "";
        for await (const chunk of command.input.Body as Readable)
          value += chunk;
        expect(value).toBe("abcd");
        return { ETag: "opaque-provider-etag" };
      }
      if (command instanceof ListPartsCommand)
        return {
          Parts: [{ PartNumber: 1, Size: 4, ETag: "opaque-provider-etag" }],
        };
      throw new Error("Unexpected command");
    },
  } as unknown as S3Client;
  const storage = s3Storage({
    client,
    bucket: "uploads",
    journal: savedJournal,
  });
  const part = await storage.writePart(
    session,
    { index: 0, size: 4, sha256: hash },
    Readable.from(["abcd"]),
    undefined,
  );
  expect(part.sha256).toBe(hash);
  expect(part.reference).toMatchObject({ etag: "opaque-provider-etag" });
  expect(await savedJournal.get(session.id)).toHaveLength(1);
  expect(await storage.probe(session, undefined)).toHaveLength(1);
});
it("does not reuse unverifiable R2 parts after an interrupted journal update", async () => {
  const client = {
    async send() {
      return { Parts: [{ PartNumber: 1, Size: 4, ETag: "unknown-etag" }] };
    },
  } as unknown as S3Client;
  const storage = r2Storage({ client, bucket: "uploads", journal: journal() });
  expect(await storage.probe(session, undefined)).toEqual([]);
});
it("rejects a streamed checksum mismatch without publishing its receipt", async () => {
  const savedJournal = journal();
  const client = {
    async send(command: UploadPartCommand) {
      for await (const _ of command.input.Body as Readable) {
      }
      return { ETag: "etag" };
    },
  } as unknown as S3Client;
  const storage = s3Storage({
    client,
    bucket: "uploads",
    journal: savedJournal,
  });
  await expect(
    storage.writePart(
      session,
      { index: 0, size: 4, sha256: hash },
      Readable.from(["xxxx"]),
      undefined,
    ),
  ).rejects.toMatchObject({ code: "CHECKSUM" });
  expect(await savedJournal.get(session.id)).toEqual([]);
});
it("recovers a multipart reference after a session-ledger interruption", async () => {
  const savedJournal = journal();
  let created = 0;
  const client = {
    async send(command: unknown) {
      expect(command).toBeInstanceOf(CreateMultipartUploadCommand);
      created++;
      return { UploadId: "persistent-multipart" };
    },
  } as unknown as S3Client;
  const storage = s3Storage({
    client,
    bucket: "uploads",
    journal: savedJournal,
  });
  const first = await storage.begin(session, undefined);
  const restarted = s3Storage({
    client,
    bucket: "uploads",
    journal: savedJournal,
  });
  expect(await restarted.begin(session, undefined)).toEqual(first);
  expect(created).toBe(1);
});

it.each(["AES256", "aws:kms"] as const)(
  "passes %s encryption settings to multipart and empty-file creation",
  async (mode) => {
    const commands: (CreateMultipartUploadCommand | PutObjectCommand)[] = [];
    const client = {
      async send(command: CreateMultipartUploadCommand | PutObjectCommand) {
        commands.push(command);
        return { UploadId: "encrypted" };
      },
    } as unknown as S3Client;
    const encryption =
      mode === "aws:kms"
        ? { mode, keyId: "alias/uploads", bucketKey: true }
        : { mode };
    const storage = s3Storage({
      client,
      bucket: "uploads",
      journal: journal(),
      encryption,
    });
    await storage.begin(session, undefined);
    const emptyStorage = s3Storage({
      client,
      bucket: "uploads",
      journal: journal(),
      encryption,
    });
    await emptyStorage.begin(
      {
        ...session,
        id: "empty",
        descriptor: { ...session.descriptor, size: 0 },
      },
      undefined,
    );
    expect(commands[0]).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(commands[1]).toBeInstanceOf(PutObjectCommand);
    for (const command of commands)
      expect(command.input).toMatchObject(
        mode === "aws:kms"
          ? {
              ServerSideEncryption: mode,
              SSEKMSKeyId: "alias/uploads",
              BucketKeyEnabled: true,
            }
          : { ServerSideEncryption: mode },
      );
  },
);
it("rejects AWS encryption options for R2 and empty KMS key IDs", () => {
  const base = {
    client: {} as S3Client,
    bucket: "uploads",
    journal: journal(),
  };
  expect(() => r2Storage({ ...base, encryption: { mode: "AES256" } })).toThrow(
    "R2",
  );
  expect(() =>
    s3Storage({ ...base, encryption: { mode: "aws:kms", keyId: " " } }),
  ).toThrow("key ID");
});
