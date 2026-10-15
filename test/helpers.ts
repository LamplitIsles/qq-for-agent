import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import type { Bot } from "../src/gateway.ts";
import type { Message } from "../src/store.ts";

export async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "qq-for-agent-test-"));
  return {
    path,
    async close() {
      await rm(path, { recursive: true, force: true });
    },
  };
}
export const config = {
  app_id: "test-app",
  app_secret: "test-secret",
  gateway_token: "test-gateway",
  port: 0,
};
export function message(
  id = "m1",
  conversation = "group:g1",
  body = "hello",
): Message {
  const [kind, native] = conversation.split(":");
  return {
    app_id: config.app_id,
    conversation_id: conversation,
    conversation_type: kind as "group" | "c2c",
    native_conversation_id: native,
    message_id: id,
    direction: "inbound",
    sender_id: "sender",
    timestamp: new Date().toISOString(),
    body,
    raw_event_type: "GROUP_MESSAGE_CREATE",
  };
}
export function fakeBot() {
  const events = new EventEmitter();
  const calls: Array<{ target: unknown; body: string }> = [];
  let send: Bot["sendText"] = async () => ({
    id: "sent",
    timestamp: Date.now() / 1000,
  });
  let resolve: (() => void) | undefined;
  const bot = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    start: () =>
      new Promise<void>((r) => {
        resolve = r;
        events.emit("ready", {});
      }),
    stop: () => resolve?.(),
    sendText: async (target: ReplyTarget, body: string) => {
      calls.push({ target, body });
      return send(target, body);
    },
  } as unknown as Bot;
  return {
    bot,
    calls,
    events,
    setSend(fn: Bot["sendText"]) {
      send = fn;
    },
  };
}
export async function endpoint(handler: RequestListener) {
  const http = createServer(handler);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;
  return {
    http,
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      const done = new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections();
      await done;
    },
  };
}
export async function until(check: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for local test condition");
    await delay(5);
  }
}
