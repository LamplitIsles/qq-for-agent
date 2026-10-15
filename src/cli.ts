#!/usr/bin/env node
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { configPath, readConfig, SafeError } from "./config.ts";
import { connect } from "./connect.ts";
import { Store } from "./store.ts";
import { Gateway } from "./gateway.ts";
import { listen } from "./mcp.ts";

const help = `qq-for-agent — official QQ text gateway (Node >=24.15)

Usage: qq-for-agent connect|serve [--config PATH]
       qq-for-agent --help

connect  Create one QQ App using the official terminal QR connector.
         Refuses to overwrite configuration. Writes private credentials.
serve    Use an existing private configuration; listen on 127.0.0.1.

Default config: ~/.local/share/qq-for-agent/config.json
Database: messages.sqlite in the config directory (one App per database).
Read README.md for existing-App config, MCP Bearer and observed-history limits.
`;
async function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        config: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch {
    throw new SafeError("Invalid arguments; use --help");
  }
  if (args.values.help || !args.positionals.length) {
    console.log(help);
    return;
  }
  if (
    args.positionals.length !== 1 ||
    !["connect", "serve"].includes(args.positionals[0])
  )
    throw new SafeError("Use connect or serve; see --help");
  const path = configPath(args.values.config);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (args.positionals[0] === "connect") {
      await connect(path, abort.signal);
      console.error(
        "QQ App credentials saved privately. Read gateway_token from the config for MCP access.",
      );
      return;
    }
    const config = readConfig(path);
    const store = new Store(
      join(dirname(path), "messages.sqlite"),
      config.app_id,
    );
    const gateway = new Gateway(config, store);
    let http;
    try {
      http = await listen(config, gateway);
      if (abort.signal.aborted) return;
      gateway.start();
      console.error(`QQ MCP listening on http://127.0.0.1:${http.port}/mcp`);
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) resolve();
        else
          abort.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
    } finally {
      await Promise.all([http?.close(), gateway.close()]);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
main().catch((error) => {
  console.error(
    error instanceof SafeError
      ? error.message
      : "Gateway failed; check private configuration and local resources",
  );
  process.exitCode = 1;
});
