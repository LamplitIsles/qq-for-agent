import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { startQrConnect } from "@tencent-connect/qqbot-connector";
import { connect } from "../src/connect.ts";
import { readConfig, configSchema } from "../src/config.ts";
import { temporary } from "./helpers.ts";

test("QR seam saves private single-App credentials, refreshes expiry, refuses overwrite", async () => {
  const temp = await temporary();
  try {
    const path = join(temp.path, "private", "config.json");
    let stops = 0;
    const logs: string[] = [];
    const start: typeof startQrConnect = (callbacks, options) => {
      assert.equal(options!.displayQrCodeToConsole, true);
      callbacks.onQrExpired?.();
      callbacks.onSuccess([{ appId: "app1", appSecret: "private-secret" }]);
      return () => {
        stops++;
      };
    };
    await connect(path, new AbortController().signal, start, (v) =>
      logs.push(v),
    );
    const c = readConfig(path);
    assert.equal(c.app_id, "app1");
    assert.equal(c.app_secret, "private-secret");
    assert.notEqual(c.gateway_token, c.app_secret);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(temp.path, "private")).mode & 0o777, 0o700);
    assert.equal(stops, 1);
    assert.match(logs[0], /expired/);
    await assert.rejects(
      connect(path, new AbortController().signal, start),
      /already exists/,
    );
    assert.equal(stops, 1);
  } finally {
    await temp.close();
  }
});

test("QR cancellation ignores late success; failure errors are safe and no config is created", async () => {
  const temp = await temporary();
  try {
    const path = join(temp.path, "config.json");
    let callbacks: Parameters<typeof startQrConnect>[0] | undefined,
      stopped = false;
    const abort = new AbortController();
    const pending = connect(path, abort.signal, (cb) => {
      callbacks = cb;
      return () => {
        stopped = true;
      };
    });
    abort.abort();
    await assert.rejects(pending, /cancelled/);
    callbacks!.onSuccess([{ appId: "late", appSecret: "secret" }]);
    assert.equal(stopped, true);
    assert.equal(existsSync(path), false);
    await assert.rejects(
      connect(path, new AbortController().signal, (cb) => {
        cb.onFailure(new Error("RAW SECRET"));
        return () => {};
      }),
      /^Error: QQ connect failed or cancelled$/,
    );
    await assert.rejects(
      connect(path, new AbortController().signal, (cb) => {
        cb.onSuccess([
          { appId: "a", appSecret: "s" },
          { appId: "b", appSecret: "s" },
        ]);
        return () => {};
      }),
      /exactly one/,
    );
    assert.equal(existsSync(path), false);
    assert.equal(
      configSchema.safeParse({
        app_id: "a",
        app_secret: "same",
        gateway_token: "same",
      }).success,
      false,
    );
  } finally {
    await temp.close();
  }
});
