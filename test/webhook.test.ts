import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Webhook } from "../src/webhook.ts";
import { endpoint, message, until } from "./helpers.ts";

test("webhook retries identical bytes serially, truncates only notification, accepts all 2xx", async () => {
  const received: string[] = [],
    auth: unknown[] = [];
  const receiver = await endpoint(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push(body);
    auth.push(req.headers.authorization);
    res.writeHead(received.length < 3 ? 503 : 202);
    res.end();
  });
  const w = new Webhook({ url: receiver.url, bearer: "receiver-only" });
  try {
    w.enqueue(message("first", "group:g1", "x".repeat(20_000)));
    w.enqueue(message("second"));
    await w.idle();
    assert.equal(received.length, 4);
    assert.equal(received[0], received[1]);
    assert.equal(received[1], received[2]);
    assert.equal(JSON.parse(received[0]).body.length, 16_000);
    assert.equal(JSON.parse(received[0]).truncated, true);
    assert.equal(JSON.parse(received[3]).message_id, "second");
    assert.deepEqual(auth, Array(4).fill("Bearer receiver-only"));
  } finally {
    await w.close();
    await receiver.close();
  }
});

test("queue capacity is 100, shutdown aborts in-flight request and prevents retries/late sends", async () => {
  let calls = 0;
  const logs: string[] = [];
  const receiver = await endpoint((_req, _res) => {
    calls++;
  });
  const w = new Webhook({ url: receiver.url }, (v) => logs.push(v));
  try {
    for (let i = 0; i < 101; i++) w.enqueue(message(`m${i}`));
    await until(() => calls === 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /queue full/);
    await w.close();
    w.enqueue(message("late"));
    await delay(300);
    assert.equal(calls, 1);
  } finally {
    await w.close();
    await receiver.close();
  }
});

test("redirects are forbidden and exhausted attempts produce a safe summary", async () => {
  let calls = 0,
    redirected = 0;
  const sink = await endpoint((_req, res) => {
    redirected++;
    res.end();
  });
  const receiver = await endpoint((_req, res) => {
    calls++;
    res.writeHead(302, { location: sink.url });
    res.end("secret upstream response");
  });
  const logs: string[] = [];
  const w = new Webhook({ url: receiver.url }, (v) => logs.push(v));
  try {
    w.enqueue(message());
    await w.idle();
    assert.equal(calls, 3);
    assert.equal(redirected, 0);
    assert.deepEqual(logs, [
      "Webhook attempts exhausted; notification dropped; stored text retained",
    ]);
  } finally {
    await w.close();
    await receiver.close();
    await sink.close();
  }
});

test("a receiver that never responds times out after five seconds before retry", async () => {
  let calls = 0;
  const receiver = await endpoint((_req, res) => {
    calls++;
    if (calls === 2) {
      res.writeHead(204);
      res.end();
    }
  });
  const w = new Webhook({ url: receiver.url });
  const started = Date.now();
  try {
    w.enqueue(message());
    await w.idle();
    assert.equal(calls, 2);
    assert.ok(Date.now() - started >= 5000);
    assert.ok(Date.now() - started < 10_000);
  } finally {
    await w.close();
    await receiver.close();
  }
});
