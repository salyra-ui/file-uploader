# salyra-upload/1

All frontend frameworks use the same HTTP contract. Your routes can have different names. Map them in `chunkedTransport({ routes })` and mount the matching server handlers.

## Create

`POST /uploads`, JSON, with `Idempotency-Key`.

```json
{
  "protocol": "salyra-upload/1",
  "name": "photo.jpg",
  "size": 9437184,
  "type": "image/jpeg",
  "lastModified": 0,
  "chunkSize": 5242880
}
```

The key is scoped to the authenticated application/user. Repeating a key with a different descriptor returns 409. The response contains `id`, `chunkSize` and `expiresAt` in Unix milliseconds. The server does not use the file name as a path.

## Probe

`GET /uploads/{id}` returns the server's durable checkpoint.

```json
{
  "status": "open",
  "parts": [
    {
      "index": 0,
      "size": 5242880,
      "sha256": "a 64-character lowercase hex digest"
    }
  ],
  "expiresAt": 1791216000000
}
```

Status is `open`, `finalizing`, `completed`, `canceled` or `expired`. Completed sessions also return `result`. Expired sessions return 410. The client checks receipt sizes, indexes and digests. Before resuming with a reselected file, it hashes every confirmed chunk and compares it with the receipt.

## Receive a part

`PUT /uploads/{id}/parts/{index}`, binary body, with `Upload-Checksum` containing its SHA-256 digest in lowercase hexadecimal. Indexes start at zero. Each part is exactly `chunkSize` bytes except the last. A zero-byte file has one zero-byte part.

The receipt contains `index`, `size`, `sha256`. Storage references and provider credentials stay on the server. Identical retransmissions are safe. A different body at an existing index is rejected. A successful response means both the body and its checkpoint are durably saved.

If the response is lost, probe before sending again. The storage adapter can recover a saved part even if its session update was interrupted.

## Finish

`POST /uploads/{id}/complete`. No client manifest is trusted. The server verifies the ordered receipts, assembles the file, saves its result and returns that result. Missing parts return 409. Repeated completion returns the same result. Ambiguous provider completion is reconciled through `inspectResult`.

## Cancel

`DELETE /uploads/{id}` deletes temporary parts and marks the session canceled. It never removes a completed file. Completed-file removal belongs to the application's authenticated catalog and `onRemove` callback.

## Errors

Responses use `{ "code": "...", "message": "..." }`. Validation uses 400, 413 or 422. Conflicting state uses 409. Expired sessions use 410. Retry-After can be seconds or an HTTP date. Only transient failures are retried automatically.

## Storage and locking

Each session operation is serialized across processes through the configured SessionStore. A chunk body is not: the session lock is held only to check a chunk and to record it, and the body streams under a lock of its own for that chunk number, so chunks of one upload arrive side by side. Recording re-reads the session, so a canceled or expired session refuses the chunk. Filesystem stores are local-host implementations. A database-backed store supplies a transaction, compare-and-swap or lease for deployments across multiple hosts. Do not share a local PID lock store across hosts.

A custom storage adapter consumes the stream once. It validates byte count and checksum, stores the part durably, and returns a serializable receipt. Its probe, finish, inspectResult and abort methods must understand those receipts. Partial overrides preserve the base reference contract explicitly.

Notification IDs are stable so applications can enqueue them into their own durable outbox. Notifications are separate from blocking authorization and validation. Default notification delivery is not an exactly-once message queue.

## Cloud session creation

The Node S3/R2 adapter persists its multipart reference in the receipt journal before returning it. If the session ledger write is interrupted, repeated creation recovers that reference using the same deterministic session ID. A lost provider response can still leave an unknown multipart upload. Configure the bucket's incomplete-multipart lifecycle cleanup for those abandoned provider sessions. Neither an application callback nor a browser cleanup record can recover a provider upload ID that was never received.

Filesystem adapters and custom provider adapters must make `begin` repeatable for the same session ID. Custom `writePart` implementations must reject replacing a confirmed part with different content and consume the complete validated stream before returning a receipt. Notifications are not a replacement for a durable outbox.

The first distribution includes single-request HTTP and the Salyra chunked transport. A tus transport requires a separate adapter because tus offsets do not expose the SHA-256 receipt list used for reselected-file verification here. Presigned direct-to-storage is also a separate transport mode. The core interface allows these integrations, but the included adapters do not silently advertise them.

[OpenAPI 3.1 specification](openapi.json) · [JSON schemas](schemas.json)
