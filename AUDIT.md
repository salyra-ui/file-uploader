# File upload audit

Audited on 5 October 2026, on the `feat/file-uploader` branch. This report covers the browser engine, UI adapters, Node engine and the shared native HTTP contract. It is not a certification of every application or cloud deployment.

## Corrections

| Area                  | Fault                                                                                     | Change and regression coverage                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File replacement      | An old asynchronous validator could finish after `attach` and queue the replacement file. | Replacement invalidates the previous generation and aborts its validator. The new file passes validation before upload.                                                               |
| Restore after cancel  | Reselecting a canceled transfer changed it to paused and reused the canceled session.     | Cancel remains a canceled state after attach. Retry creates a fresh session.                                                                                                          |
| Terminal records      | Attaching a file could turn a completed record into a pending transfer.                   | Completed records reject attach. Expired records require Reset first.                                                                                                                 |
| Persistence           | A slow adapter accumulated 203 intermediate writes after 100 Cancel/Reset cycles.         | One write runs at a time and only the latest waiting checkpoint is retained. The regression records at most three writes and verifies the final state.                                |
| React ownership       | Replacing an owned Root store could invalidate its cleanup and leave it active.           | Cleanup generations belong to each owned store. Replacement destroys the old owned store. A borrowed store stays alive when its Root unmounts.                                        |
| Server expiration     | A published result could be treated as temporary data when its finalizing ledger expired. | Probe and duplicate Create recover the destination first in all nine native engines and Node. Node expiry sweeps also reconcile before cleanup and recheck expiration under the lock. |
| Node notifications    | An onEvent callback reading its own session could reenter the storage transaction.        | Notifications are delivered after the operation releases its locks, including nested creation/recovery transactions. Callback errors still do not undo the committed transfer.        |
| Example accessibility | Copy code was a non-tab child of a tablist. Empty-state text failed contrast checks.      | Copy sits outside the tablist, text contrast passes, tabs use arrow/Home/End navigation, and row status changes have polite announcements.                                            |

## Evidence

- 46 unit/fault tests, including 12 late-response cases across Pause, Cancel and Reset during Create, Probe, Upload and Complete.
- A 1,000-file queue drains while keeping the shared request count at four.
- 28 interaction scenarios per browser cover the five compiled framework adapters, Vanilla examples, refresh/reselect, cancellation, deletion, ownership and keyboard controls.
- Local Chromium and WebKit runs pass. The Linux CI browser job also passes all 84 scenarios across Chromium, Firefox and WebKit. Firefox's macOS binary fails before opening a page with `Could not find profile folder`, so its verification uses Linux.
- Nine native engines pass the shared HTTP suite, real process-restart recovery and recovery of a published file whose finalizing ledger has expired. Kotlin and Scala bridge builds and C/C++ sanitizer tests run in that matrix.
- All 54 public example recipes parse or compile. Framework compilation and SSR isolation checks pass.
- Fresh installs of both release archives compile and execute without unrequested framework or provider peers. Archives contain dist and package metadata, with no source maps or source-map references.
- axe-core reports no WCAG 2 A/AA or WCAG 2.1 AA violations on the example page and the five compiled framework fixtures. Automated checks do not replace manual screen-reader testing.

### Large file measurement

`node --import tsx scripts/stress.ts` sends a disk-backed 2 GiB file through the real Node HTTP router and filesystem storage. It hashes the source and completed file independently and compares them. A sparse source fixture avoids preloading the file into memory.

| Setting / measurement             | Result                     |
| --------------------------------- | -------------------------- |
| File size                         | 2,147,483,648 bytes        |
| Chunk size                        | 8 MiB                      |
| Concurrent chunks / requests      | 2 / 2                      |
| Baseline RSS                      | 89 MiB                     |
| Peak RSS                          | 174 MiB                    |
| Additional RSS                    | 85 MiB                     |
| Upload plus final hash comparison | 81.2 seconds               |
| Completed content                 | SHA-256 matches the source |

Client and server share one process in this test. These are observed values on this machine, not promised throughput or browser memory figures. The script cleans its temporary data and asserts an additional-RSS ceiling of 384 MiB. CI repeats the same 2 GiB test.

## Deployment boundaries

- S3 and R2 adapters have SDK/provider-response tests. Live AWS and Cloudflare buckets, their IAM policies and provider outages have not been exercised with credentials.
- Filesystem session locks coordinate processes on one host. Elixir coordinates connected BEAM nodes. Independent hosts need a transactional shared store. A shared mount alone is not a database lease.
- Every engine receives the chunks of one upload side by side: the session lock is held only to check and to record, and the body streams under a per-chunk lock from the same store. The filesystem stores' chunk lock files are removed when their session is saved as finished; those of an abandoned session stay until the application removes them, like its session lock file and metadata, because the native engines have no sweep. A custom storage must tolerate `write_part` side by side for different chunk numbers.
- Native notification callbacks execute after storage commits while the operation may still own its session lock. Keep them short and write/enqueue an application outbox. Do not call engine operations from those callbacks. Node onEvent callbacks run after lock release. Neither callback API guarantees durable delivery after a crash.
- The host application supplies authentication, authorization on every operation, request limits, TLS, storage permissions, an uploaded-file catalog and completed-file removal. The authorization tests verify user isolation and scope separation, not an application's identity provider.
- Root options are initial configuration. Svelte, Vue and Angular keep the store selected when mounted. Use `store.setOptions` for supported live interaction flags and keyed/remounted Roots for a different queue. React also releases an owned store when it is replaced.
- Python and C filesystem code targets Unix. Windows filesystem behavior and real distributed database session stores have not been verified.
- A restored transfer requires the original file to be reselected. Browser metadata persistence does not silently retain file contents or grant disk access.
- The 1,000-file regression tests the engine queue. Large application lists should use pagination or virtualization rather than rendering every preview at once.

## Reproduce

Run the commands in STATUS.md. `scripts/native.sh` uses a private temporary data directory for each engine, restarts its example server and removes its own container and fixtures on exit. `scripts/stress.ts` accepts `SALYRA_STRESS_BYTES` for a smaller local smoke check.

## Optional storage encryption

The Node encrypted filesystem adapter has 19 storage regressions. Three additional provider tests verify S3 AES256/KMS options on multipart and empty-file creation, and reject AWS encryption options on R2. Together with the existing tests, 68 unit/fault cases pass.

Verified cases include out-of-order assembly, cancel/retry with a fresh session, interrupted request cleanup, missing receipt/checkpoint recovery, completion recovery after finalization expiry, retained-key rotation after restart, missing/wrong keys, altered ciphertext and tags, truncation, trailing bytes, swapped parts and swapped sessions. Downloads emit each frame only after authentication. Derived keys are released on stream completion or cancellation. Request context reaches the keyring and borrowed application key buffers are not overwritten.

A real HTTP transfer of 2,147,483,648 bytes using encrypted storage finished and its decrypted SHA-256 matched the source. The local combined client/server measurement was 39.5 seconds, baseline RSS 88 MiB, peak 204 MiB and additional RSS 116 MiB. The benchmark streams a disk-backed file and checks the same 384 MiB additional-RSS ceiling as the ordinary storage test. CI runs both modes.

AES-256-GCM, HKDF-SHA-256 and HMAC-SHA-256 use Node crypto. The container format and key lifecycle are documented in ENCRYPTION.md. There has been no independent cryptographic review. Application metadata and plaintext digests are outside the content encryption boundary. Encryption adapters for native backends, browser end-to-end encryption and migration of existing plaintext storage are not included.
