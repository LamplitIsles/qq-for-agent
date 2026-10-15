import { createServer, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Gateway } from "./gateway.ts";
import { SafeError, type Config } from "./config.ts";

export function mcpTools(g: Gateway) {
  const server = new McpServer({ name: "qq-for-agent", version: "0.1.0" });
  const run = (fn: () => unknown) => async () => {
    try {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(await fn()) }],
      };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              e instanceof SafeError ? e.message : "Gateway operation failed",
          },
        ],
      };
    }
  };
  const id = z.string().min(1).max(1024);
  const page = {
    limit: z.number().int().min(1).max(100).default(20),
    before: z.string().min(1).max(4096).optional(),
  };
  server.registerTool(
    "whoami",
    { inputSchema: {} },
    run(() => ({
      app_id: g.store.appId,
      connection_state: g.state,
      identity_source: "configured_app",
    })),
  );
  server.registerTool("list_conversations", { inputSchema: page }, (p) =>
    run(() => g.store.conversations(p.limit, p.before))(),
  );
  server.registerTool(
    "read_messages",
    { inputSchema: { conversation_id: id, ...page } },
    (p) => run(() => g.store.read(p.conversation_id, p.limit, p.before))(),
  );
  server.registerTool(
    "send_message",
    {
      inputSchema: {
        conversation_id: id,
        body: z.string().min(1).max(16000),
        reply_to_message_id: id.optional(),
      },
    },
    (p) =>
      run(() => g.send(p.conversation_id, p.body, p.reply_to_message_id))(),
  );
  return server;
}
export async function listen(config: Config, gateway: Gateway) {
  if (!config.gateway_token || config.gateway_token === config.app_secret)
    throw new SafeError("Independent gateway Bearer required");
  const active = new Set<McpServer>();
  const json = (res: ServerResponse, status: number, message: string) => {
    res.req.resume();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message },
      }),
    );
  };
  const http = createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    const count = req.rawHeaders.filter(
      (v, i) => i % 2 === 0 && v.toLowerCase() === "authorization",
    ).length;
    const provided = req.headers.authorization;
    const expected = `Bearer ${config.gateway_token}`;
    if (
      count !== 1 ||
      typeof provided !== "string" ||
      Buffer.byteLength(provided) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
      json(res, 401, "Unauthorized");
      return;
    }
    if (req.url !== "/mcp") {
      json(res, 404, "Not found");
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      json(res, 405, "Method not allowed");
      return;
    }
    let server: McpServer | undefined;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 128_000) {
          json(res, 413, "Request exceeds 128000 byte limit");
          return;
        }
        chunks.push(chunk);
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        json(res, 400, "Invalid JSON");
        return;
      }
      server = mcpTools(gateway);
      active.add(server);
      const current = server;
      res.once("close", () => {
        active.delete(current);
        void current.close();
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch {
      if (!res.headersSent && !res.destroyed) json(res, 500, "Request failed");
      if (server) {
        active.delete(server);
        await server.close();
      }
    }
  });
  http.requestTimeout = 15_000;
  http.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, "127.0.0.1", () => {
      http.off("error", reject);
      resolve();
    });
  });
  return {
    port: (http.address() as { port: number }).port,
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        http.close((e) => (e ? reject(e) : resolve())),
      );
      await Promise.allSettled([...active].map((s) => s.close()));
      http.closeAllConnections();
      await closed;
    },
  };
}
