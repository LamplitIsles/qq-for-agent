import { AsyncLocalStorage } from "node:async_hooks";
import type { QQBot, ReplyTarget } from "@tencent-connect/qqbot-nodejs";

interface Scope {
  signal: AbortSignal;
  requestMs: number;
  requests: Set<Promise<Response>>;
}
const context = new AsyncLocalStorage<Scope>();
let installation:
  { original: typeof fetch; wrapper: typeof fetch; owners: number } | undefined;

function acquireFetch() {
  if (!installation) {
    const original = globalThis.fetch;
    const wrapper: typeof fetch = async (input, init) => {
      const scope = context.getStore();
      if (!scope) return original(input, init);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), scope.requestMs);
      const signal = AbortSignal.any([
        scope.signal,
        abort.signal,
        ...(init?.signal ? [init.signal] : []),
        ...(input instanceof Request ? [input.signal] : []),
      ]);
      const request = (async () => {
        try {
          const response = await original(input, { ...init, signal });
          // SDK 1.0.5 clears its own deadline at headers. Consume the entire
          // text/API response while our real fetch signal still owns the body.
          const body = response.body ? await response.arrayBuffer() : null;
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } finally {
          clearTimeout(timer);
        }
      })();
      scope.requests.add(request);
      try {
        return await request;
      } finally {
        scope.requests.delete(request);
      }
    };
    globalThis.fetch = wrapper;
    installation = { original, wrapper, owners: 0 };
  }
  if (globalThis.fetch !== installation.wrapper)
    throw new Error("SDK fetch boundary ownership changed");
  installation.owners++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--installation!.owners === 0) {
      // Another owner may have installed a fetch implementation meanwhile.
      // Never overwrite its choice when releasing our last SDK owner.
      if (globalThis.fetch === installation!.wrapper)
        globalThis.fetch = installation!.original;
      installation = undefined;
    }
  };
}

// The SDK invokes inbound listeners within its async scope. Receiver HTTP must
// retain its own independent timeout, acknowledgment and cancellation semantics.
export function outsideSdkIo<T>(fn: () => T): T {
  return context.exit(fn);
}

export class SdkIo {
  private lifetime = new AbortController();
  private requests = new Set<Promise<Response>>();
  private startupTimer?: ReturnType<typeof setTimeout>;
  private release = acquireFetch();
  private operationMs: number;
  private startupMs: number;
  constructor(timeouts: { operationMs?: number; startupMs?: number } = {}) {
    // Internal seam for local deadline tests; not operator configuration.
    this.operationMs = timeouts.operationMs ?? 30_000;
    this.startupMs = timeouts.startupMs ?? 10_000;
  }
  private run<T>(signal: AbortSignal, fn: () => T): T {
    return context.run(
      { signal, requestMs: this.operationMs, requests: this.requests },
      fn,
    );
  }
  async start(bot: Pick<QQBot, "start" | "stop">) {
    let expired = false;
    this.startupTimer = setTimeout(() => {
      expired = true;
      this.cancel();
      bot.stop();
    }, this.startupMs);
    try {
      await this.run(this.lifetime.signal, () => bot.start());
      if (expired) throw new Error("QQ startup deadline exceeded");
    } finally {
      this.ready();
    }
  }
  ready() {
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
  }
  async send(bot: Pick<QQBot, "sendText">, target: ReplyTarget, body: string) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.operationMs);
    try {
      return await this.run(
        AbortSignal.any([this.lifetime.signal, deadline.signal]),
        () => bot.sendText(target, body),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  cancel() {
    this.ready();
    this.lifetime.abort();
  }
  async close() {
    this.cancel();
    await Promise.allSettled(this.requests);
    this.release();
  }
}
