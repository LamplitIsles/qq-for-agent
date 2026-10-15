import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/store.ts";
import { Gateway } from "../src/gateway.ts";
import { listen } from "../src/mcp.ts";
import { config, fakeBot, message, temporary } from "./helpers.ts";

test("real MCP HTTP client enforces static Bearer and provides observed-history tools", async () => {
  const temp = await temporary(),
    f = fakeBot();
  const s = new Store(join(temp.path, "messages.sqlite"), config.app_id);
  const g = new Gateway(config, s, f.bot);
  g.start();
  s.insert(message("plain", "group:g1", "not at-mentioned"));
  s.insert(message("other", "c2c:u1"));
  const http = await listen(config, g),
    url = `http://127.0.0.1:${http.port}/mcp`;
  const client = new Client({ name: "local-test", version: "1" });
  const raw = (token?: string, body = "{}", method = "POST") =>
    fetch(url, {
      method,
      headers: {
        ...(token ? { authorization: token } : {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: method === "POST" ? body : undefined,
    });
  try {
    for (const token of [
      undefined,
      "Bearer wrong",
      `Bearer ${config.app_secret}`,
      `Bearer ${config.gateway_token}, Bearer ${config.gateway_token}`,
    ])
      assert.equal((await raw(token)).status, 401);
    const duplicateStatus = await new Promise<number>((resolve) => {
      const req = request(
        url,
        {
          method: "POST",
          headers: [
            "Host",
            `127.0.0.1:${http.port}`,
            "Authorization",
            `Bearer ${config.gateway_token}`,
            "Authorization",
            `Bearer ${config.gateway_token}`,
          ],
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.end("{}");
    });
    assert.equal(duplicateStatus, 401);
    assert.equal(
      (await raw(`Bearer ${config.gateway_token}`, "{bad")).status,
      400,
    );
    assert.equal(
      (await raw(`Bearer ${config.gateway_token}`, "x".repeat(128_001))).status,
      413,
    );
    assert.equal(
      (await raw(`Bearer ${config.gateway_token}`, "", "GET")).status,
      405,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers: { authorization: `Bearer ${config.gateway_token}` },
        },
      }),
    );
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name).sort(),
      ["list_conversations", "read_messages", "send_message", "whoami"],
    );
    const call = async (name: string, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ text: string }>)[0].text;
      return {
        result,
        text,
        value: result.isError ? undefined : JSON.parse(text),
      };
    };
    assert.equal((await call("whoami")).value.app_id, config.app_id);
    assert.ok(!(await call("whoami")).text.includes(config.app_secret));
    assert.equal(
      (await call("list_conversations")).value.conversations.length,
      2,
    );
    const read = await call("read_messages", { conversation_id: "group:g1" });
    assert.equal(read.value.messages[0].body, "not at-mentioned");
    assert.equal(read.value.incomplete, true);
    assert.equal(
      (
        await call("read_messages", {
          conversation_id: "group:g1",
          before: "invalid",
        })
      ).result.isError,
      true,
    );
    const badReply = await call("send_message", {
      conversation_id: "group:g1",
      body: "reply",
      reply_to_message_id: "other",
    });
    assert.equal(badReply.result.isError, true);
    assert.equal(f.calls.length, 0);
    assert.equal(
      (
        await call("send_message", {
          conversation_id: "group:g1",
          body: "reply",
          reply_to_message_id: "plain",
        })
      ).value.status,
      "sent",
    );
    assert.equal(
      (await call("read_messages", { conversation_id: "group:g1" })).value
        .messages[1].direction,
      "outbound",
    );
  } finally {
    await client.close();
    await http.close();
    await g.close();
    await temp.close();
  }
});
