import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { QQBot } from "@tencent-connect/qqbot-nodejs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/store.ts";
import { Gateway } from "../src/gateway.ts";
import { listen } from "../src/mcp.ts";
import { config, endpoint, temporary, until } from "./helpers.ts";

// Real SDK HTTP auth/API and WebSocket dispatch, against local endpoints only.
// This fixture implements just HELLO / IDENTIFY / RESUME / a few events, not QQ.
test("actual SDK persists non-@ messages, suppresses replay before RESUMED, and sends once through REST", async () => {
  const temp = await temporary();
  const notifications: Array<Record<string, unknown>> = [];
  let receiverBodiesClosed = 0;
  const receiver = await endpoint(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    notifications.push(JSON.parse(body));
    // Headers alone acknowledge a webhook. SDK-scoped fetch buffering must
    // not capture this receiver HTTP request from the SDK event callback.
    res.writeHead(200);
    res.write("ignored receiver body that never ends");
    res.once("close", () => {
      receiverBodiesClosed++;
    });
  });
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  let sendMode = "success",
    connections = 0,
    current: WebSocket | undefined;
  let gatewayUrl = "";
  const qq = await endpoint(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url === "/app/getAppAccessToken") {
      res.end(
        JSON.stringify({ access_token: "local-token", expires_in: 7200 }),
      );
      return;
    }
    if (req.url === "/gateway") {
      res.end(JSON.stringify({ url: gatewayUrl }));
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/messages")) {
      sent.push({ path: req.url, body: JSON.parse(body) });
      if (sendMode === "network") {
        req.socket.destroy();
        return;
      }
      res.end(
        JSON.stringify(
          sendMode === "bad"
            ? {}
            : { id: `sent${sent.length}`, timestamp: Date.now() / 1000 },
        ),
      );
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  gatewayUrl = qq.url.replace("http:", "ws:");
  const ws = new WebSocketServer({ server: qq.http });
  let seq = 0;
  const dispatch = (type: string, data: unknown) =>
    current!.send(JSON.stringify({ op: 0, t: type, s: ++seq, d: data }));
  const group = (id: string, body: string, at = false) =>
    dispatch(at ? "GROUP_AT_MESSAGE_CREATE" : "GROUP_MESSAGE_CREATE", {
      id,
      content: body,
      timestamp: new Date().toISOString(),
      author: { member_openid: "user1", username: "User" },
      group_openid: "g1",
      ...(at
        ? { mentions: [{ member_openid: "test-app", is_you: true }] }
        : {}),
      auth_token: "must-not-store",
      attachments: [
        { url: "must-not-store-ticket", content_type: "image/png" },
      ],
      msg_elements: [{ content: "quoted text is not the new message" }],
    });
  const handshakes: number[] = [];
  ws.on("connection", (socket) => {
    connections++;
    current = socket;
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
    socket.on("message", (raw) => {
      const payload = JSON.parse(String(raw));
      if (payload.op === 2) {
        handshakes.push(payload.op);
        dispatch("READY", {
          session_id: "local-session",
          user: { id: "sdk-bot-id" },
        });
      }
      if (payload.op === 6) {
        handshakes.push(payload.op);
        // Official docs: missed events precede RESUMED. Send all frames together
        // to expose any asynchronous SDK handler ordering mistakes.
        group("ROBOT1.0_plain", "ordinary group context");
        group("replayed", "newly observed replay", true);
        dispatch("RESUMED", "");
        group("after-resume", "fresh after resume", true);
      }
      if (payload.op === 1) socket.send(JSON.stringify({ op: 11 }));
    });
  });
  const c = { ...config, webhook: { url: receiver.url } };
  const path = join(temp.path, "messages.sqlite");
  const bot = new QQBot({
    appId: c.app_id,
    appSecret: c.app_secret,
    baseUrl: qq.url,
    tokenBaseUrl: qq.url,
    intents: 1 << 25,
    reconnect: { delays: [1] },
  });
  const g = new Gateway(c, new Store(path, c.app_id), bot);
  const http = await listen(c, g);
  const client = new Client({ name: "sdk-test", version: "1" });
  let closed = false;
  try {
    g.start();
    await until(() => g.state === "connected");
    group("ROBOT1.0_plain", "ordinary group context");
    await until(() => notifications.length === 1);
    group("at", "@bot summarize context", true);
    await until(() => notifications.length === 2);
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${http.port}/mcp`),
        {
          requestInit: {
            headers: { authorization: `Bearer ${c.gateway_token}` },
          },
        },
      ),
    );
    const result = await client.callTool({
      name: "read_messages",
      arguments: { conversation_id: "group:g1" },
    });
    const page = JSON.parse(
      (result.content as Array<{ text: string }>)[0].text,
    );
    assert.deepEqual(
      page.messages.map((m: { body: string }) => m.body),
      ["ordinary group context", "@bot summarize context"],
    );
    assert.equal(page.observed_only, true);
    assert.ok(!JSON.stringify(page).includes("must-not-store"));
    assert.equal(notifications[0].raw_event_type, "GROUP_MESSAGE_CREATE");
    assert.equal(notifications[1].raw_event_type, "GROUP_AT_MESSAGE_CREATE");
    assert.deepEqual(notifications[1].mentions, [
      { member_openid: "test-app", is_you: true },
    ]);
    current!.send(JSON.stringify({ op: 7 }));
    await until(() => connections === 2 && notifications.length === 3);
    assert.deepEqual(handshakes, [2, 6]);
    assert.deepEqual(
      notifications.map((n) => n.message_id),
      ["ROBOT1.0_plain", "at", "after-resume"],
    );
    assert.deepEqual(
      g.store.read("group:g1").messages.map((m) => m.message_id),
      ["ROBOT1.0_plain", "at", "replayed", "after-resume"],
    );
    await g.send("group:g1", "exact reply body", "at");
    assert.equal(sent[0].path, "/v2/groups/g1/messages");
    assert.equal(sent[0].body.msg_id, "at");
    assert.equal(sent[0].body.content, "exact reply body");
    assert.equal(sent[0].body.msg_type, 0);
    await g.send("group:g1", "explicit proactive");
    assert.equal("msg_id" in sent[1].body, false);
    // Confirmed outbound ID observed as an SDK echo never notifies or duplicates.
    group("sent1", "exact reply body");
    sendMode = "network";
    await assert.rejects(
      g.send("group:g1", "unknown network"),
      /outcome unknown/,
    );
    assert.equal(sent.length, 3);
    sendMode = "bad";
    await assert.rejects(
      g.send("group:g1", "unknown receipt"),
      /outcome unknown/,
    );
    assert.equal(sent.length, 4);
    await g.webhook!.idle();
    assert.equal(notifications.length, 3);
    await until(() => receiverBodiesClosed === 3);
    dispatch("C2C_MESSAGE_CREATE", {
      id: "ROBOT1.0_c2c+/=",
      content: "direct context",
      timestamp: new Date().toISOString(),
      author: { user_openid: "u1" },
    });
    await until(() => notifications.length === 4);
    sendMode = "success";
    await g.send("c2c:u1", "direct reply", "ROBOT1.0_c2c+/=");
    assert.equal(sent[4].path, "/v2/users/u1/messages");
    assert.equal(sent[4].body.msg_id, "ROBOT1.0_c2c+/=");
    await client.close();
    await http.close();
    await g.close();
    closed = true;
    const reopened = new Gateway(
      c,
      new Store(path, c.app_id),
      new QQBot({
        appId: c.app_id,
        appSecret: c.app_secret,
        transport: { start: async () => {}, stop() {} },
      }),
    );
    assert.equal(reopened.store.read("group:g1").messages.length, 6);
    assert.equal(reopened.store.read("c2c:u1").messages.length, 2);
    await reopened.webhook!.idle();
    assert.equal(notifications.length, 4);
    await reopened.close();
    assert.equal(bot.tokenManager.getStatus(c.app_id).status, "valid");
  } finally {
    if (!closed) {
      await client.close();
      await http.close();
      await g.close();
    }
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await qq.close();
    await receiver.close();
    await temp.close();
  }
});
