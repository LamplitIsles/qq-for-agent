import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { QQBot } from "@tencent-connect/qqbot-nodejs";
import { Gateway } from "../src/gateway.ts";
import { Store } from "../src/store.ts";
import { SdkIo } from "../src/sdk-io.ts";
import { config, message, temporary, until } from "./helpers.ts";

// Drips keep a socket active indefinitely: an inactivity timeout cannot pass.
async function stalledQQ(kind: "send" | "token", tokenDelay = 0) {
  const sockets = new Set<Socket>();
  let response: ServerResponse | undefined;
  let received!: () => void;
  const headers = new Promise<void>((resolve) => {
    received = resolve;
  });
  let requests = 0,
    closedBodies = 0,
    closedSockets = 0;
  const server = createServer(async (req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    if (kind === "send" && req.url === "/app/getAppAccessToken") {
      await delay(tokenDelay);
      res.end(
        JSON.stringify({ access_token: "local-token", expires_in: 7200 }),
      );
      return;
    }
    if (
      req.url !==
      (kind === "send" ? "/v2/groups/g1/messages" : "/app/getAppAccessToken")
    ) {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    requests++;
    req.socket.once("close", () => {
      closedSockets++;
    });
    response = res;
    res.writeHead(200);
    res.flushHeaders();
    res.write(kind === "send" ? '{"id":"' : '{"access_token":"');
    const drip = setInterval(() => res.write("x"), 20);
    res.once("close", () => {
      clearInterval(drip);
      closedBodies++;
    });
    received();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    headers,
    get requests() {
      return requests;
    },
    get closedSockets() {
      return closedSockets;
    },
    get closedBodies() {
      return closedBodies;
    },
    lateSuccess() {
      response?.end('","timestamp":1}');
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function within(task: Promise<unknown>, ms = 1000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function gateway(
  path: string,
  url: string,
  timeouts: { operationMs: number; startupMs: number },
) {
  const bot = new QQBot({
    appId: config.app_id,
    appSecret: config.app_secret,
    baseUrl: url,
    tokenBaseUrl: url,
  });
  const store = new Store(join(path, "messages.sqlite"), config.app_id);
  // Additional constructor argument is an internal test seam, never config/CLI.
  const g = new Gateway(config, store, bot, () => {}, timeouts);
  return { g, store };
}

test("complete send deadline includes token acquisition and dripping body, aborts actual I/O once", async () => {
  const temp = await temporary(),
    fixture = await stalledQQ("send", 300);
  const { g, store } = gateway(temp.path, fixture.url, {
    operationMs: 600,
    startupMs: 1000,
  });
  store.insert(message("in"));
  const started = performance.now();
  let result: unknown;
  const sending = g.send("group:g1", "single POST").catch((error) => {
    result = error;
  });
  try {
    await fixture.headers;
    assert.equal(
      await within(sending, 700),
      true,
      "send must finish within the whole-operation deadline despite dripping body",
    );
    assert.match(String(result), /outcome unknown.*Do not blindly resend/);
    assert.ok(performance.now() - started < 800);
    await until(
      () => fixture.closedBodies === 1 && fixture.closedSockets === 1,
    );
    assert.equal(fixture.requests, 1);
    assert.equal(store.read("group:g1").messages.length, 1);
    assert.equal(await within(g.close()), true);
  } finally {
    await fixture.close();
    await sending;
    await g.close();
    await temp.close();
  }
});

test("stop cancels active send body and late success cannot write after SQLite close", async () => {
  const temp = await temporary(),
    fixture = await stalledQQ("send");
  const { g, store } = gateway(temp.path, fixture.url, {
    operationMs: 5000,
    startupMs: 5000,
  });
  store.insert(message("in"));
  let dbClosed = false,
    lateWrites = 0;
  const insert = store.insert.bind(store);
  store.insert = (m) => {
    if (dbClosed) lateWrites++;
    return insert(m);
  };
  let result: unknown;
  const sending = g.send("group:g1", "stop during body").catch((error) => {
    result = error;
  });
  let closing: Promise<void> | undefined;
  try {
    await fixture.headers;
    closing = g.close();
    assert.equal(
      await within(closing),
      true,
      "stop must retire the in-flight send, rather than wait for SDK body completion",
    );
    dbClosed = true;
    await sending;
    assert.match(String(result), /outcome unknown/);
    await until(
      () => fixture.closedBodies === 1 && fixture.closedSockets === 1,
    );
    fixture.lateSuccess();
    await delay(60);
    assert.equal(fixture.requests, 1);
    assert.equal(lateWrites, 0);
    const reopened = new Store(
      join(temp.path, "messages.sqlite"),
      config.app_id,
    );
    assert.equal(reopened.read("group:g1").messages.length, 1);
    reopened.close();
  } finally {
    await fixture.close();
    await sending;
    await closing;
    await g.close();
    await temp.close();
  }
});

for (const stopEarly of [false, true]) {
  test(`startup token dripping body is cancelled by ${stopEarly ? "stop" : "startup deadline"}, with bounded close`, async () => {
    const temp = await temporary(),
      fixture = await stalledQQ("token");
    const { g } = gateway(temp.path, fixture.url, {
      operationMs: 5000,
      startupMs: stopEarly ? 5000 : 200,
    });
    let closing: Promise<void> | undefined;
    try {
      g.start();
      await fixture.headers;
      assert.throws(() => g.start(), /already started/);
      if (!stopEarly) await until(() => g.state === "error", 1000);
      closing = g.close();
      assert.equal(
        await within(closing),
        true,
        "close must cancel pending startup token body",
      );
      await until(
        () => fixture.closedBodies === 1 && fixture.closedSockets === 1,
      );
      assert.equal(fixture.requests, 1);
    } finally {
      await fixture.close();
      await closing;
      await g.close();
      await temp.close();
    }
  });
}

test("SDK fetch ownership is shared, outside fetch remains streaming, release preserves another owner", async () => {
  const baselineFetch = globalThis.fetch;
  const temp = await temporary(),
    fixture = await stalledQQ("send");
  const first = gateway(join(temp.path, "first"), fixture.url, {
    operationMs: 200,
    startupMs: 5000,
  });
  const second = gateway(join(temp.path, "second"), fixture.url, {
    operationMs: 200,
    startupMs: 5000,
  });
  second.store.insert(message("in"));
  const original = globalThis.fetch;
  let externalCalls = 0;
  let external: typeof fetch | undefined;
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.write("first");
    const timer = setTimeout(() => res.end("-last"), 350);
    res.once("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let sending: Promise<unknown> | undefined;
  try {
    await first.g.close();
    const outsideTask = fetch(url);
    assert.equal(
      await within(outsideTask, 200),
      true,
      "outside fetch must expose headers before the body completes",
    );
    const outside = await outsideTask;
    // Outside the SDK scope, headers arrive immediately and body outlives the
    // SDK's 200ms deadline without buffering/abort by the SDK wrapper.
    assert.equal(await outside.text(), "first-last");
    let error: unknown;
    sending = second.g.send("group:g1", "still has SDK boundary").catch((e) => {
      error = e;
    });
    assert.equal(await within(sending), true);
    assert.match(String(error), /outcome unknown/);
    await until(() => fixture.closedSockets === 1);
    // Simulate a separate fetch owner installed after us. Last SDK release
    // must not replace that owner's implementation.
    external = (...args) => {
      externalCalls++;
      return original(...args);
    };
    globalThis.fetch = external;
    await second.g.close();
    assert.equal(await (await fetch(url)).text(), "first-last");
    assert.equal(externalCalls, 1);
  } finally {
    await fixture.close();
    await sending;
    await first.g.close();
    await second.g.close();
    // This test owns the external wrapper in its isolated Node test process.
    if (globalThis.fetch === external) globalThis.fetch = baselineFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await temp.close();
  }
});

for (const stopEarly of [false, true]) {
  test(`real SDK background token refresh after ready is cancelled by ${stopEarly ? "lifetime stop" : "request deadline"}`, async () => {
    const temp = await temporary();
    let tokens = 0,
      bodyClosed = false,
      socketClosed = false;
    const sockets = new Set<Socket>();
    let received!: () => void;
    const headers = new Promise<void>((resolve) => {
      received = resolve;
    });
    const server = createServer((req, res) => {
      req.resume();
      tokens++;
      res.setHeader("content-type", "application/json");
      if (tokens === 1) {
        res.end(
          JSON.stringify({ access_token: "local-token", expires_in: 7200 }),
        );
        return;
      }
      res.writeHead(200);
      res.write('{"access_token":"');
      const drip = setInterval(() => res.write("x"), 20);
      req.socket.once("close", () => {
        socketClosed = true;
      });
      res.once("close", () => {
        clearInterval(drip);
        bodyClosed = true;
      });
      received();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let finish!: () => void;
    let bot: QQBot;
    // Public custom transport hosts the real TokenManager background loop in the
    // same SDK run scope. Only its scheduling interval is shortened for the test.
    bot = new QQBot({
      appId: config.app_id,
      appSecret: config.app_secret,
      baseUrl: base,
      tokenBaseUrl: base,
      transport: {
        start: () => {
          bot.tokenManager.startBackgroundRefresh(
            config.app_id,
            config.app_secret,
            {
              minRefreshIntervalMs: 10,
              refreshAheadMs: 8_000_000,
              randomOffsetMs: 0,
            },
          );
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
        stop: () => finish(),
      },
    });
    const io = new SdkIo({
      operationMs: stopEarly ? 5000 : 200,
      startupMs: 1000,
    });
    const run = io.start(bot);
    io.ready();
    try {
      await until(
        () => bot.tokenManager.getStatus(config.app_id).status === "valid",
      );
      bot.tokenManager.clearCache(config.app_id);
      await headers;
      if (!stopEarly) await until(() => bodyClosed && socketClosed);
      io.cancel();
      bot.stop();
      await run;
      await io.close();
      await until(() => bodyClosed && socketClosed);
      assert.equal(
        bot.tokenManager.isBackgroundRefreshRunning(config.app_id),
        false,
      );
      await delay(100);
      assert.equal(tokens, 2);
    } finally {
      io.cancel();
      bot.stop();
      for (const socket of sockets) socket.destroy();
      await run;
      await io.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await temp.close();
    }
  });
}
