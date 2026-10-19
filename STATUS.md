# File Uploader 0.1.0 implementation

The browser and Node packages are built locally. Registry publication is a separate release operation. The native integrations are source packages in this repository, with their own manifests and build instructions.

## Included

- Single-request HTTP and the verified `salyra-upload/1` chunked transport
- Queue limits, request concurrency, retry and Retry-After, pause, cancel and reset
- IndexedDB session persistence, reselecting the original file and checking every saved chunk before resume
- Per-item subscriptions, coalesced progress updates, byte counts, transfer speed and ETA
- Uploaded records, paginated history and application-owned removal callbacks
- React, Svelte, Vue, Angular, Astro and Vanilla compositions with custom markup, classes, content and native events
- Separate Node server operations, configurable routes, authorization context, session stores and storage adapters
- Filesystem storage and Node S3/R2 storage with a persistent multipart receipt journal
- Optional Node encrypted filesystem storage, application key rotation and authenticated streaming downloads
- Explicit S3-managed AES256 or KMS encryption settings for new objects
- Native engines for Go, Rust, Java, .NET, Python, PHP, Ruby, Elixir and C, plus Kotlin, Scala and C++ bridges
- API reference, working Preview/Code examples, all six frontend framework recipes, protocol schemas and a versioned documentation snapshot

## Verification

| Check                | Result                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript           | Browser engine, adapters, Node server, local examples and test scripts compile                                                                                                                                                       |
| Frameworks           | Svelte and Astro compile, Angular partial compilation passes, React and Vue SSR isolate stores                                                                                                                                       |
| Public recipes       | All 54 framework/example combinations parse or compile                                                                                                                                                                               |
| Unit and fault cases | 87 tests pass, including interrupted responses, retry, persistence, cleanup, provider responses and per-item notification behavior                                                                                                   |
| Browser interaction  | 84 browser tests pass in Linux CI across Chromium, Firefox and WebKit against the real Node server, including five compiled framework adapters, refresh/reselect, completed-file deletion and Cancel → Retry across all compositions |
| Documentation        | 30 tests pass across the existing component catalog, uploader guide, browser simulation, mobile layouts, downloads and immutable version links                                                                                       |
| Package consumer     | Fresh installs of the actual npm archives compile with NodeNext and run without unrequested framework or provider peers. React, Vue and Angular adapter types also compile with their selected peers                                 |
| Native HTTP protocol | Nine running backend engines pass the same compatibility suite and the side-by-side chunk checks                                                                                                                                     |
| Process restart      | Saved parts survive a server restart in all nine backend engines and finish with the same session ID                                                                                                                                 |
| JVM bridges          | Kotlin and Scala integration projects compile against the Java engine                                                                                                                                                                |
| C/C++ ownership      | C and C++ tests pass with AddressSanitizer and UndefinedBehaviorSanitizer                                                                                                                                                            |
| Build contents       | npm archives contain dist, package.json, README and LICENSE. No sourcemaps or source-map references                                                                                                                                  |

The production documentation build uses `/docs/`, matching GitHub Pages. Its downloadable Vanilla files include standard and minified JavaScript and CSS. Framework JavaScript is minified. Svelte and Astro retain compact compiler inputs, which their toolchains require.

The follow-up [audit report](AUDIT.md) records the corrected races, browser coverage, 2 GiB transfer measurements and deployment limits. The Linux browser CI job passes all three browsers. Firefox's local macOS binary fails before page launch.

## Deployment boundaries

S3 and R2 behavior is checked with provider response fixtures and the real AWS SDK against a local HTTP endpoint. Live AWS and Cloudflare credentials and buckets have not been used. Built-in provider SDK adapters belong to the Node package. Other languages use their storage interfaces for provider integration.

The included filesystem session stores coordinate on one host, or on connected BEAM nodes for Elixir. Independent hosts need a transactional shared session store. The Python and C filesystem implementations target Unix. Windows-specific filesystem behavior has not been verified.

Each backend uses its own persistence format. The HTTP contract is shared, but a filesystem directory is not a database migration between backend languages.

The native example servers demonstrate routing and streams. Application authentication, access rules, TLS, limits and durable notification delivery belong to the host application. The C socket example is a local compatibility server.

The first distribution does not include a tus adapter or a presigned direct-to-storage transport. These require different reconciliation contracts. The core transport interface remains open to those integrations.

## Reproduce

```sh
npm ci --legacy-peer-deps
npm run check
npm run check:frameworks
npm run check:examples
npm test
npm run build
node scripts/consumer.mjs
node scripts/framework-browser.mjs
node --import tsx scripts/stress.ts
npx playwright install chromium firefox webkit
npm run test:browser
npm run test:native -- go
```

Repeat the native command for rust, jvm, python, php, ruby, dotnet, elixir and c. The GitHub workflow runs that matrix and the browser/package checks on pushes and pull requests.

## Storage encryption verification

The encrypted 2 GiB HTTP transfer completed in 39.5 seconds locally and its decrypted SHA-256 matched the source. Combined client/server RSS rose from 88 MiB to 204 MiB, an additional 116 MiB. The benchmark limit is 384 MiB of additional RSS. These are measurements on this machine, not a throughput guarantee.

The 34 tests cover authenticated storage, tampering, sealed receipts (no plaintext digest in the adapter's directory, format 1 receipts still read), receipt recovery, key rotation, canceled transfers, empty files, interrupted streams, request context and S3 encryption settings. Fresh archive consumers can import `/encryption` without installing the AWS SDK. Native engines keep their existing storage extension interfaces. Built-in encrypted disk storage is currently Node only.

```sh
SALYRA_STRESS_ENCRYPTED=1 node --import tsx scripts/stress.ts
```

See [ENCRYPTION.md](ENCRYPTION.md) for the format, key ownership, downloads and the distinction from browser end-to-end encryption.
