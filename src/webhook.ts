import { setTimeout as delay } from "node:timers/promises";
import type { Message } from "./store.ts";
import type { Config } from "./config.ts";

export type Log = (summary: string) => void;
export class Webhook {
  private queue: string[] = [];
  private controller = new AbortController();
  private running?: Promise<void>;
  private config: NonNullable<Config["webhook"]>;
  private log: Log;
  constructor(
    config: NonNullable<Config["webhook"]>,
    log: Log = console.error,
  ) {
    this.config = config;
    this.log = log;
  }
  enqueue(message: Message) {
    if (this.controller.signal.aborted) return;
    if (this.queue.length >= 100) {
      this.log(
        "Webhook queue full; notification dropped; stored text retained",
      );
      return;
    }
    const max = 16_000;
    const { body, ...facts } = message;
    this.queue.push(
      JSON.stringify({
        ...facts,
        body: body.slice(0, max),
        truncated: body.length > max,
      }),
    );
    this.running ??= this.drain().finally(() => {
      this.running = undefined;
    });
  }
  private async drain() {
    const signal = this.controller.signal;
    while (this.queue.length && !signal.aborted) {
      const body = this.queue[0];
      let delivered = false;
      for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), 5000);
        try {
          const res = await fetch(this.config.url, {
            method: "POST",
            redirect: "error",
            headers: {
              "content-type": "application/json",
              ...(this.config.bearer
                ? { authorization: `Bearer ${this.config.bearer}` }
                : {}),
            },
            body,
            signal: AbortSignal.any([signal, timeout.signal]),
          });
          delivered = res.ok;
          await res.body?.cancel();
        } catch {
          /* Only safe summaries escape this boundary. */
        } finally {
          clearTimeout(timer);
        }
        if (delivered) break;
        if (attempt < 2)
          await delay(250, undefined, { signal }).catch(() => {});
      }
      this.queue.shift();
      if (!delivered && !signal.aborted)
        this.log(
          "Webhook attempts exhausted; notification dropped; stored text retained",
        );
    }
  }
  async idle() {
    await this.running;
  }
  async close() {
    this.controller.abort();
    await this.running;
    this.queue.length = 0;
  }
}
