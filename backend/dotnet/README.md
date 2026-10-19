# Salyra upload server · dotnet

Native engine and HTTP integration for `salyra-upload/1`. The application owns authentication, routes, metadata and final file removal.

See [backend integrations](../README.md) for build commands and [the protocol](../../protocol/README.md) for request/response schemas, storage contracts, idempotency and recovery.

The included example binds to localhost. Filesystem adapters target one host with persistent state. For distributed deployments, implement the session transaction and storage interfaces with a database lease or provider appropriate to the application.

MIT licensed.
