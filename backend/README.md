# Backend integrations

The browser framework does not determine the server language. Every integration implements `salyra-upload/1` and exposes its engine separately from HTTP routing. Importing an engine does not start a server.

| Language                | Source                        | HTTP integration                                     | Build                                             |
| ----------------------- | ----------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| TypeScript / JavaScript | `../packages/upload-server`   | Node handlers or application controllers             | `npm run build` from repository root              |
| Go                      | `go`                          | `net/http`                                           | `go test ./...`                                   |
| Rust                    | `rust`                        | optional `http` feature                              | `cargo test --features http`                      |
| Java                    | `jvm`                         | JDK HttpServer or application controllers            | `mvn package`                                     |
| Kotlin                  | `jvm/integrations/kotlin`     | CompletableFuture and suspend bridge over JVM engine | `mvn package` after installing JVM engine         |
| Scala                   | `jvm/integrations/scala`      | Future wrapper over JVM engine                       | `mvn package` after installing JVM engine         |
| C# / .NET               | `dotnet`                      | ASP.NET Core                                         | `dotnet build Salyra.Upload/Salyra.Upload.csproj` |
| Python                  | `python`                      | WSGI                                                 | Python 3.11 or newer                              |
| PHP                     | `php`                         | explicit HTTP dispatcher                             | PHP 8.2 or newer                                  |
| Ruby                    | `ruby`                        | Rack                                                 | Ruby 3.1 or newer                                 |
| Elixir                  | `elixir`                      | Plug                                                 | `mix deps.get && mix compile`                     |
| C                       | `c`                           | call engine from your router                         | `cmake -S . -B build && cmake --build build`      |
| C++                     | `c/include/salyra_upload.hpp` | RAII wrapper over C engine                           | same CMake build                                  |

The programs named `example` bind to localhost by default. They demonstrate the protocol. Mount the handlers in your own server to provide authentication, TLS, request deadlines and application routing. The C socket program is a bounded local test server, not an HTTP framework.

## Session state and storage

A session store holds the descriptor, expiration, confirmed parts and result. A storage adapter receives the body as a stream, keeps temporary parts, inspects its real checkpoint, finalizes the ordered manifest and aborts temporary data.

The native implementations include filesystem storage. S3 and R2 provider adapters are supplied in the Node package. Other engines accept custom storage implementations through their interfaces or callbacks. Installing a native backend does not include an S3 SDK or claim native S3 support.

Use storage outside the web root. The original filename is metadata, never a storage path. The filesystem adapters use generated identifiers and publish through a temporary file on the same filesystem. Hashes and sizes are checked before final publication.

Filesystem coordination has an explicit deployment boundary. Go, Rust, Python, PHP, Ruby, JVM, .NET and C use host operating-system locks. Node uses local process leases that recognise a lock left by an earlier run with the same PID. Elixir uses `:global` locks across connected BEAM nodes. Multiple unrelated hosts or disconnected BEAM clusters require a transactional database session store rather than a shared filesystem directory. Python's included filesystem lock and the C filesystem implementation target Unix.

## Own routes and request context

Call the engine's create, probe, part, finish and cancel operations from your own controllers. Router adapters accept their route matcher or dispatch operation. Pass authenticated request context to `scope`, `authorize` and validation hooks. Match the client transport's routes to the chosen paths.

Every engine requires `authorize`: without it, anyone who reaches the routes could create, read and finish uploads. Construction fails (Rust refuses each operation, C returns `NULL`) unless anonymous access is explicit: `AllowAnonymous` (Go, .NET), `allow_anonymous` (Python, Ruby, Rust, C, Elixir), `allowAnonymous` (PHP, JVM, Node). The examples set it because they are local demos.

Creation accepts its metadata only as `application/json` and answers 415 otherwise: a cross-site form can post `text/plain` without a CORS preflight, but not this type. The included clients already send it.

Every engine receives the chunks of one upload side by side. The session lock is held only to check a chunk and, once its body is stored, to record it. The body streams outside that lock, under a lock of its own for that chunk number, taken from the same lock store as the session lock with the key `<session id>-part-<index>`. A session ID is a hex digest, so that key is never another session's ID.

1. Check (session lock): authorization, session state, chunk number and checksum. A chunk number that is already recorded is verified outside any lock: the retransmitted body is read and hashed, and it must match the recorded checksum and size (413 `PART_SIZE`, 409 `PART_CONFLICT`).
2. Write (chunk lock): the session is read again, because another request may have stored this chunk number while this one waited. Then the storage writes the body and the receipt is checked (500 `STORAGE_RECEIPT`).
3. Record (session lock): the session is read again, so one that was canceled or expired while the body streamed refuses the chunk (409 `STATE` or 410 `EXPIRED`), and chunks recorded in the meantime are kept. The chunk joins the session in index order, the session's expiry moves to now plus the TTL when that is later (the TTL counts inactivity, as in the Node engine) and `part-stored` is sent.

A request that waits for the lock of a chunk that is streaming waits as the store's lock does: 30 s and then 503 `BUSY` in Node, the retry budget of `:global.trans` and then `BUSY` in Elixir, until the request is canceled in Go, Rust, JVM and .NET, and without a limit in Python, PHP, Ruby and C (blocking `flock`). The filesystem storages write one receipt file per chunk through unique temporary names, and the session record is only changed in step 3 after a fresh read, so chunks received side by side cannot overwrite each other's receipts or each other's place in the session. A custom storage or receipt journal must do the same: `write_part` is called side by side for different chunk numbers of one upload.

The chunk lock files of the filesystem session stores (`<id>-part-<index>.lock`, in the same directory as the session's lock) are removed when the session is saved as completed, canceled or expired. A chunk that is still streaming then is refused at its record. Unfinished sessions keep theirs, as they keep their session lock file; the native engines do not sweep abandoned sessions. Elixir's `:global` locks leave no files. .NET keeps one in-process semaphore per lock file, not a shared set of stripes: a request that holds a chunk lock and takes the session lock would otherwise wait for itself whenever both hashed to the same stripe.

Creation uses a stable idempotency key scoped to the application/user. Access to an existing session is still authorized on every operation. A completed-file list and deletion route belong to the application's catalog, not the temporary-session engine.

Notification IDs are stable per session and event, including the part number for part events. Notifications occur after the relevant storage commit. A reliable business workflow should write to an application outbox with these IDs. A callback alone is not a durable delivery guarantee. Native notification callbacks may run while the session lock is held. Keep them short, enqueue work in an application outbox, and do not call engine operations from the callback. The Node engine delivers onEvent after releasing its locks.

## Compatibility checks

Run each example on its chosen port, then run the shared HTTP checks from the repository root:

```sh
node --import tsx scripts/compatibility.ts http://127.0.0.1:4335/uploads
```

The shared checks exercise duplicate creation, conflicting descriptors, out-of-order chunks, incomplete manifests, duplicate parts, changed content, checkpoint reconciliation, repeated completion and cancel protection. `scripts/parallel.ts` adds the side-by-side behavior over HTTP: a half-sent chunk blocks no other chunk, a twin of a streaming chunk waits for it and a different body is a conflict, a session canceled mid-stream does not take the chunk, and 24 chunks at once all reach the session record, extend its expiry and leave no chunk locks behind. `php -S` reads a request body whole, so the PHP run skips the cases that need a chunk to stall inside the engine; `php/tests/parallel.php` covers them with child processes whose bodies are pipes. Go, Rust and C have engine-level versions of the same cases (`go test`, `cargo test`, ctest). The example servers handle requests concurrently for this reason: a server that serves one request at a time cannot show the behavior. Node fault tests additionally cover lost acknowledgments and ledger gaps. C/C++ tests run under AddressSanitizer and UndefinedBehaviorSanitizer.

The implementation contract and storage-specific limits are in [the protocol guide](../protocol/README.md). Package names and artifacts are defined in each integration's manifest. Registry publishing remains a separate release operation.
