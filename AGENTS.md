# Verification

Run `bun run typecheck`, `bun run test`, `bun run build`, then
`node dist/cli.js --help`. Tests run under Node for `node:sqlite`; Bun manages
dependencies and builds the Node executable with external npm dependencies.

# Test-owned state

Use temporary directories for config/SQLite and local fake HTTP/WebSocket
endpoints for SDK/MCP/webhook checks. Inject the connector seam for QR tests.
Tests must never access real user config, installed artifacts, QQ credentials,
Tencent authorization, live receivers, or real messages. Clean up only artifacts
created in the test-owned directory. Help and argument parsing must create no state.
