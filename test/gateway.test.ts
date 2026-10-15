import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  ApiError,
  type QQBotInboundMessage,
} from "@tencent-connect/qqbot-nodejs";
import { Store } from "../src/store.ts";
import { Gateway, inbound } from "../src/gateway.ts";
import { config, fakeBot, message, temporary } from "./helpers.ts";

export function sdkMessage(id = "m1", overrides = {}): QQBotInboundMessage {
  return {
    kind: "group",
    groupOpenid: "g1",
    senderId: "user1",
    senderName: "User",
    content: "top-level text",
    messageId: id,
    timestamp: new Date().toISOString(),
    rawEventType: "GROUP_MESSAGE_CREATE",
    replyTarget: { scope: "group", targetId: "g1", msgId: id },
    raw: {
      id,
      content: "top-level text",
      timestamp: new Date().toISOString(),
      group_openid: "g1",
      author: { member_openid: "user1" },
    },
    ...overrides,
  };
}

test("ingestion preserves only top-level text and documented facts; late events after stop do nothing", async () => {
  const temp = await temporary(),
    f = fakeBot();
  const store = new Store(join(temp.path, "messages.sqlite"), config.app_id);
  const logs: string[] = [];
  const g = new Gateway(config, store, f.bot, (v) => logs.push(v));
  g.start();
  const input = sdkMessage("m1", {
    msgElements: [{ content: "quoted text" }],
    refMsgIdx: "quote-index",
    mentions: [{ member_openid: "u2", is_you: true, auth_token: "NEVER" }],
    raw: { auth_token: "NEVER", ticket: "NEVER" },
  });
  f.events.emit("message", {}, input);
  f.events.emit("message", {}, input);
  f.events.emit(
    "message",
    {},
    sdkMessage("attachment", {
      content: "",
      attachments: [{ url: "secret-ticket" }],
    }),
  );
  assert.equal(store.read("group:g1").messages.length, 1);
  assert.equal(store.read("group:g1").messages[0].body, "top-level text");
  assert.equal(store.read("group:g1").messages[0].ref_msg_idx, "quote-index");
  assert.ok(!JSON.stringify(store.read("group:g1")).includes("NEVER"));
  assert.equal(
    inbound(config.app_id, sdkMessage("x", { kind: "guild" })),
    undefined,
  );
  assert.equal(
    inbound(config.app_id, sdkMessage("x", { timestamp: "nonsense" })),
    undefined,
  );
  await g.close();
  f.events.emit("message", {}, sdkMessage("late"));
  assert.equal(f.events.listenerCount("message"), 0);
  assert.equal(logs.length, 0);
  await temp.close();
});

test("send validates reply scope/time, preserves body, records receipts and never retries unknown", async () => {
  const temp = await temporary(),
    f = fakeBot();
  const s = new Store(join(temp.path, "messages.sqlite"), config.app_id);
  const g = new Gateway(config, s, f.bot);
  try {
    s.insert(message("in"));
    s.insert(message("other", "group:g2"));
    assert.equal((await g.send("group:g1", " exact body ", "in")).stored, true);
    assert.deepEqual(f.calls[0], {
      target: { scope: "group", targetId: "g1", msgId: "in" },
      body: " exact body ",
    });
    assert.equal(s.read("group:g1").messages.at(-1)!.direction, "outbound");
    await g.send("group:g2", "proactive");
    assert.deepEqual(f.calls[1].target, { scope: "group", targetId: "g2" });
    const before = f.calls.length;
    await assert.rejects(
      g.send("group:g1", "bad", "other"),
      /not observed inbound/,
    );
    await assert.rejects(
      g.send("group:g1", "bad", "sent"),
      /not observed inbound/,
    );
    await assert.rejects(g.send("group:unknown", "bad"), /not observed/);
    s.insert({
      ...message("old"),
      timestamp: new Date(Date.now() - 301_000).toISOString(),
    });
    await assert.rejects(g.send("group:g1", "bad", "old"), /expired/);
    s.insert({
      ...message("c2c", "c2c:u1"),
      timestamp: new Date(Date.now() - 600_000).toISOString(),
    });
    f.setSend(async () => ({ id: "c2c-sent", timestamp: Date.now() / 1000 }));
    await g.send("c2c:u1", "within sixty minutes", "c2c");
    assert.equal(f.calls.length, before + 1);
    f.setSend(async () => {
      throw new Error("network error SECRET");
    });
    await assert.rejects(
      g.send("group:g1", "unknown"),
      /outcome unknown.*Do not blindly resend/,
    );
    assert.equal(f.calls.length, before + 2);
    f.setSend(async () => ({ id: "", timestamp: 0 }));
    await assert.rejects(g.send("group:g1", "bad receipt"), /outcome unknown/);
    f.setSend(async () => {
      throw new ApiError("SECRET", 403, "/test");
    });
    await assert.rejects(
      g.send("group:g1", "forbidden"),
      /^Error: QQ rejected send/,
    );
    f.setSend(async () => ({ id: "confirmed", timestamp: Number.NaN }));
    const insert = s.insert.bind(s);
    s.insert = () => {
      throw new Error("disk full SECRET");
    };
    const result = await g.send("group:g1", "confirmed with disk error");
    assert.equal(result.status, "sent");
    assert.equal(result.message_id, "confirmed");
    assert.equal(result.stored, false);
    s.insert = insert;
  } finally {
    await g.close();
    await temp.close();
  }
});

test("storage failure suppresses notification and shutdown waits for confirmed in-flight send", async () => {
  const temp = await temporary(),
    f = fakeBot();
  const s = new Store(join(temp.path, "messages.sqlite"), config.app_id);
  const logs: string[] = [];
  const g = new Gateway(
    { ...config, webhook: { url: "http://127.0.0.1:1" } },
    s,
    f.bot,
    (v) => logs.push(v),
  );
  let notifications = 0;
  g.webhook!.enqueue = () => {
    notifications++;
  };
  g.start();
  s.insert(message("in"));
  const insert = s.insert.bind(s);
  s.insert = () => {
    throw new Error("disk full SECRET");
  };
  f.events.emit("message", {}, sdkMessage("not-stored"));
  assert.equal(notifications, 0);
  assert.deepEqual(logs, ["Inbound storage failed; notification suppressed"]);
  s.insert = insert;
  let complete:
    ((value: { id: string; timestamp: number }) => void) | undefined;
  f.setSend(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const send = g.send("group:g1", "in flight");
  const close = g.close();
  assert.throws(() => g.send("group:g1", "late send"), /stopped/);
  complete!({ id: "late-confirmation", timestamp: Date.now() / 1000 });
  assert.equal((await send).stored, true);
  await close;
  const reopened = new Store(join(temp.path, "messages.sqlite"), config.app_id);
  assert.equal(
    reopened.read("group:g1").messages.at(-1)!.message_id,
    "late-confirmation",
  );
  reopened.close();
  await temp.close();
});
