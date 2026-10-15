import {
  ApiError,
  QQBot,
  type QQBotInboundMessage,
  type ReplyTarget,
} from "@tencent-connect/qqbot-nodejs";
import { SafeError, type Config } from "./config.ts";
import { Store, type Message } from "./store.ts";
import { Webhook, type Log } from "./webhook.ts";
import { SdkIo, outsideSdkIo } from "./sdk-io.ts";

export type Bot = Pick<QQBot, "on" | "off" | "start" | "stop" | "sendText">;
const validRouteId = (s: unknown): s is string =>
  typeof s === "string" && /^[a-zA-Z0-9_\-=]{1,512}$/.test(s);
// Allow only documented mention fields; never retain arbitrary raw-event fields.
const mentionFields = [
  "scope",
  "id",
  "user_openid",
  "member_openid",
  "nickname",
  "username",
  "bot",
  "is_you",
] as const;
const validMessageId = (s: unknown): s is string =>
  typeof s === "string" &&
  s.length > 0 &&
  s.length <= 1024 &&
  !/[\s\x00-\x1f\x7f]/.test(s);
export function inbound(
  appId: string,
  msg: QQBotInboundMessage,
): Message | undefined {
  if (msg.kind !== "group" && msg.kind !== "c2c") return;
  const native = msg.kind === "group" ? msg.groupOpenid : msg.senderId;
  if (
    !validRouteId(native) ||
    !validMessageId(msg.messageId) ||
    !validRouteId(msg.senderId) ||
    typeof msg.content !== "string" ||
    !msg.content.trim() ||
    !Number.isFinite(Date.parse(msg.timestamp))
  )
    return;
  const mentions = msg.mentions?.map((m) =>
    Object.fromEntries(
      mentionFields.flatMap((key) => {
        const v = m[key];
        return typeof v === "string" || typeof v === "boolean"
          ? [[key, v]]
          : [];
      }),
    ),
  );
  return {
    app_id: appId,
    conversation_id: `${msg.kind}:${native}`,
    conversation_type: msg.kind,
    native_conversation_id: native,
    message_id: msg.messageId,
    direction: "inbound",
    sender_id: msg.senderId,
    ...(typeof msg.senderName === "string"
      ? { sender_name: msg.senderName }
      : {}),
    timestamp: msg.timestamp,
    body: msg.content,
    raw_event_type: msg.rawEventType,
    ...(mentions ? { mentions } : {}),
    ...(typeof msg.refMsgIdx === "string"
      ? { ref_msg_idx: msg.refMsgIdx }
      : {}),
  };
}
export class Gateway {
  readonly store: Store;
  readonly bot: Bot;
  readonly webhook?: Webhook;
  state = "connecting";
  private live = false;
  private stopped = false;
  private run?: Promise<void>;
  private sends = new Set<Promise<unknown>>();
  private listeners: Array<() => void> = [];
  private log: Log;
  private io: SdkIo;
  constructor(
    config: Config,
    store: Store,
    bot: Bot = new QQBot({
      appId: config.app_id,
      appSecret: config.app_secret,
      intents: 1 << 25,
    }),
    log: Log = console.error,
    timeouts: { operationMs?: number; startupMs?: number } = {},
  ) {
    this.io = new SdkIo(timeouts);
    this.store = store;
    this.bot = bot;
    this.log = log;
    if (config.webhook) this.webhook = new Webhook(config.webhook, log);
    const ready = () => {
      this.io.ready();
      if (!this.stopped) {
        this.live = true;
        this.state = "connected";
      }
    };
    const disconnected = () => {
      this.live = false;
      this.state = "recovering";
    };
    const error = () => {
      this.log("QQ SDK connection/handler error");
    };
    const message = (_ctx: unknown, msg: QQBotInboundMessage) => {
      // Synchronous SQLite commits preserve dispatch order; capture live at arrival,
      // before a later RESUMED event can change it. No async ingestion backlog.
      if (this.stopped) return;
      const m = inbound(store.appId, msg);
      if (!m) return;
      try {
        if (store.insert(m) && this.live)
          outsideSdkIo(() => this.webhook?.enqueue(m));
      } catch {
        this.log("Inbound storage failed; notification suppressed");
      }
    };
    bot.on("ready", ready);
    bot.on("resumed", ready);
    bot.on("disconnected", disconnected);
    bot.on("error", error);
    bot.on("message", message);
    this.listeners.push(() => {
      bot.off("ready", ready);
      bot.off("resumed", ready);
      bot.off("disconnected", disconnected);
      bot.off("error", error);
      bot.off("message", message);
    });
  }
  start() {
    if (this.stopped || this.run)
      throw new SafeError("Gateway already started or stopped");
    this.run = this.io.start(this.bot).then(
      () => {
        if (!this.stopped) {
          this.live = false;
          this.state = "disconnected";
        }
      },
      () => {
        if (!this.stopped) {
          this.live = false;
          this.state = "error";
          this.log("QQ connection stopped with an error");
        }
      },
    );
  }
  send(conversation: string, body: string, reply?: string) {
    if (this.stopped) throw new SafeError("Gateway stopped");
    const task = this.sendOnce(conversation, body, reply);
    this.sends.add(task);
    void task.finally(() => this.sends.delete(task)).catch(() => {});
    return task;
  }
  private async sendOnce(conversation: string, body: string, reply?: string) {
    if (!body.trim() || body.length > 16_000)
      throw new SafeError("Body must contain 1–16000 characters of text");
    const c = this.store.conversation(conversation);
    const target: ReplyTarget = {
      scope: c.conversation_type,
      targetId: c.native_conversation_id,
    };
    if (reply !== undefined) {
      const source = this.store.message(conversation, reply);
      if (!source || source.direction !== "inbound")
        throw new SafeError(
          "Reply target not observed inbound in this conversation",
        );
      const age = Date.now() - Date.parse(source.timestamp);
      if (age < 0 || age >= (c.conversation_type === "group" ? 5 : 60) * 60_000)
        throw new SafeError("Reply target expired or has an invalid time");
      target.msgId = reply;
    }
    let receipt;
    try {
      receipt = await this.io.send(this.bot, target, body);
    } catch (e) {
      if (e instanceof ApiError && e.httpStatus >= 400 && e.httpStatus < 500)
        throw new SafeError(
          "QQ rejected send; check permissions, reply limits and recipient settings",
        );
      throw new SafeError(
        "Send outcome unknown; message may have been sent. Do not blindly resend.",
      );
    }
    if (!validMessageId(receipt?.id))
      throw new SafeError(
        "Send outcome unknown; message may have been sent. Do not blindly resend.",
      );
    const receiptTime = new Date(
      typeof receipt.timestamp === "number"
        ? receipt.timestamp * 1000
        : receipt.timestamp,
    );
    const timestamp = Number.isFinite(receiptTime.getTime())
      ? receiptTime.toISOString()
      : new Date().toISOString();
    const message: Message = {
      app_id: this.store.appId,
      ...c,
      message_id: receipt.id,
      direction: "outbound",
      sender_id: this.store.appId,
      timestamp,
      body,
    };
    try {
      this.store.insert(message);
      return { status: "sent", message_id: receipt.id, stored: true };
    } catch {
      return {
        status: "sent",
        message_id: receipt.id,
        stored: false,
        warning:
          "QQ confirmed send; local storage failed. Do not resend to repair storage.",
      };
    }
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    this.live = false;
    this.state = "stopped";
    this.io.cancel();
    this.bot.stop();
    for (const remove of this.listeners) remove();
    this.listeners.length = 0;
    await this.webhook?.close();
    await this.run;
    await Promise.allSettled(this.sends);
    await this.io.close();
    this.store.close();
  }
}
