# Salyra UI File Uploader

An upload engine, composable UI parts and a separate server library. Files can be sent in one request or in verified chunks. The interface belongs to the application.

| Package                    | Purpose                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `@salyra-ui/file-uploader` | Browser engine and React, Svelte, Vue, Angular, Astro and Vanilla adapters |
| `@salyra-ui/upload-server` | Node engine, configurable HTTP handlers and filesystem/S3/R2 storage       |

Native server integrations live in `backend/`. They share the HTTP protocol with the Node implementation. JVM languages share one engine. C++ uses the C engine with RAII ownership.

## Development

Use Node 22.19 or newer.

```sh
npm ci --legacy-peer-deps
npm run dev
```

Open `http://127.0.0.1:4334`. The examples send files to the included local server. Data stays in `.uploads/`, outside the public web root. Remove that directory to clear local test uploads.

```sh
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
```

The build creates separate packages under `release/`. Each archive contains `dist`, README, LICENSE and the package manifest. No sourcemaps or source-map references are shipped. Framework JavaScript is minified. Svelte and Astro include compact compiler inputs. Vanilla includes standard and minified browser JS/CSS.

## Layout

- `packages/file-uploader/src/core`: queue, state, retries, persistence and verified resume
- `packages/file-uploader/src/transport`: HTTP and chunked transports
- `packages/file-uploader/src/{react,svelte,vue,angular,astro,vanilla}`: composable UI adapters
- `packages/upload-server/src`: server operations, routing and independent storage interfaces
- `backend`: native server integrations
- `protocol`: versioned OpenAPI, JSON schemas and reconciliation rules
- `examples`: working browser compositions
- `tests`: real transfers, fault cases, provider responses and browser interaction

[Audit and measured limits](AUDIT.md) · [Client guide](packages/file-uploader/README.md) · [Node server](packages/upload-server/README.md) · [Backend integrations](backend/README.md) · [Protocol](protocol/README.md)

Run `npm run test:native -- go` (or another language from the backend table) to build its server in Docker, execute the shared protocol tests and recover a saved upload after a server restart, and recover a committed result whose ledger expired. The script removes its own container when it finishes.
