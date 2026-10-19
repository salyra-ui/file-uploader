# Salyra UI Upload Server

Persistent upload sessions with streaming storage and configurable routes. Importing the package does not register routes or start a server.

```sh
npm install @salyra-ui/upload-server
```

```ts
import { createServer } from "node:http";
import {
  createUploadServer,
  createUploadRouter,
  UploadServerError,
} from "@salyra-ui/upload-server";
import {
  filesystemSessionStore,
  filesystemStorage,
} from "@salyra-ui/upload-server/filesystem";

const engine = createUploadServer({
  sessionStore: filesystemSessionStore("./private-uploads/sessions"),
  storage: filesystemStorage("./private-uploads/content"),
  maxFileSize: 128 * 1024 * 1024,
  // From your application's authentication: the context is what createUploadRouter's
  // `context(request)` returns. Without authorize the server refuses to start, unless
  // `allowAnonymous: true` (local demos only).
  scope: (user) => user.id,
  authorize: (operation, session, user) => {
    if (!user) throw new UploadServerError(401, "AUTH", "Sign in to upload");
  },
});
const upload = createUploadRouter(engine, {
  basePath: "/documents/uploads",
  context: (request) => currentUser(request), // your session lookup
});
createServer(async (request, response) => {
  if (!(await upload(request, response))) {
    response.writeHead(404);
    response.end();
  }
}).listen(3000, "127.0.0.1");
```

Call `createUpload`, `getUpload`, `receivePart`, `finishUpload` and `cancelUpload` directly from your own controllers. Session storage and file storage are independent interfaces.

`/s3` exports `s3Storage` and `r2Storage`. Install `@aws-sdk/client-s3` for these adapters and supply a persistent receipt journal. Provider SDKs are excluded from the core server entry.

## Expired sessions

Expired uploads are cleaned up when they are next touched, or by `sweepExpired()`. Run it on a
schedule, otherwise abandoned temporary data stays on disk or in the bucket:

```ts
setInterval(() => engine.sweepExpired().catch(reportError), 15 * 60 * 1000);
```

With S3 or R2, also add a lifecycle rule that aborts incomplete multipart uploads after a few
days: a provider upload whose ID never reached the server can only be removed that way.

[Documentation](https://salyra-ui.github.io/docs/upload-server.html) · [Protocol](https://github.com/salyra-ui/file-upload/blob/main/protocol/README.md)

Notifications run after the storage transaction releases its locks. `onEvent` can inspect the committed session. Callback failures reach `onNotificationError` and do not turn a committed transfer into a failed response. Persist an application outbox for work that must survive a process crash.

An expired finalizing session inspects the destination before cleanup. A committed result is recovered as completed during probe, duplicate creation and expiry sweeping.

## Encrypted storage

`/encryption` exports `encryptedFilesystemStorage`. Supply a private directory and a keyring whose `current(context)` selects a 32-byte key and whose `resolve(id, context)` loads retained key versions. The browser transport stays the same. The server encrypts chunks on disk and `storage.read(id, context)` returns an authenticated, decrypted stream for your download route.

Keep keys in your application secret store and retain previous versions for existing uploads. A missing key fails the operation and never falls back to plaintext. The adapter seals the checksums in its own receipts. Filenames, descriptors, sizes and the plaintext checksums in your session store remain metadata that you protect (see ENCRYPTION.md, "What stays visible"). This is storage encryption, not browser end-to-end encryption.

S3 also accepts `encryption: { mode: "AES256" }` or `{ mode: "aws:kms", keyId: "alias/uploads", bucketKey: true }`. R2 uses its own provider encryption and rejects these AWS options.

[Encryption, downloads and key rotation](https://salyra-ui.github.io/docs/upload-server.html#encryption) · [Storage format](https://github.com/salyra-ui/file-upload/blob/feat/file-uploader/ENCRYPTION.md)
