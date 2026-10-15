import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { statSync, readFileSync } from "node:fs";
import { Store } from "../src/store.ts";
import { message, temporary, config } from "./helpers.ts";

test("SQLite keeps observed text across restart, deduplicates and binds App", async () => {
  const temp = await temporary();
  try {
    const path = join(temp.path, "private", "messages.sqlite");
    let s = new Store(path, config.app_id);
    assert.deepEqual(s.conversations().conversations, []);
    assert.equal(s.insert(message()), true);
    assert.equal(s.insert(message()), false);
    assert.equal(s.read("group:g1").messages.length, 1);
    assert.equal(statSync(join(temp.path, "private")).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    for (const suffix of ["-wal", "-shm"])
      assert.equal(statSync(path + suffix).mode & 0o777, 0o600);
    s.close();
    s = new Store(path, config.app_id);
    assert.equal(s.read("group:g1").messages[0].body, "hello");
    s.close();
    assert.throws(() => new Store(path, "other-app"), /different App/);
    assert.ok(!readFileSync(path).includes(Buffer.from(config.app_secret)));
  } finally {
    await temp.close();
  }
});

test("stable pages handle equal timestamps, insertions, conversation scope and byte budget", async () => {
  const temp = await temporary();
  const s = new Store(join(temp.path, "messages.sqlite"), config.app_id);
  try {
    const timestamp = new Date().toISOString();
    for (let i = 0; i < 5; i++) s.insert({ ...message(`m${i}`), timestamp });
    const first = s.read("group:g1", 2);
    assert.deepEqual(
      first.messages.map((m) => m.message_id),
      ["m3", "m4"],
    );
    s.insert({ ...message("m5"), timestamp });
    const second = s.read("group:g1", 2, first.next!);
    assert.deepEqual(
      second.messages.map((m) => m.message_id),
      ["m1", "m2"],
    );
    assert.deepEqual(
      s.read("group:g1", 2, second.next!).messages.map((m) => m.message_id),
      ["m0"],
    );
    s.insert(message("other", "c2c:u1"));
    assert.throws(() => s.read("c2c:u1", 2, first.next!), /Invalid cursor/);
    assert.throws(() => s.read("group:g1", 2, "garbage"), /Invalid cursor/);
    assert.throws(() => s.read("group:unknown"), /not observed/);
    assert.throws(() => s.read("group:g1", 101), /Limit/);
    const c1 = s.conversations(1);
    s.insert(message("new", "group:g2"));
    assert.equal(
      s.conversations(1, c1.next!).conversations[0].conversation_id,
      "group:g1",
    );
    assert.throws(() => s.conversations(1, first.next!), /Invalid cursor/);
    s.insert(message("large1", "group:g1", "x".repeat(300_000)));
    s.insert(message("large2", "group:g1", "y".repeat(300_000)));
    const large = s.read("group:g1");
    assert.equal(large.messages.length, 1);
    assert.equal(
      s.read("group:g1", 1, large.next!).messages[0].message_id,
      "large1",
    );
    s.insert(message("huge", "group:g1", "x".repeat(600_000)));
    assert.throws(() => s.read("group:g1"), /response budget/);
  } finally {
    s.close();
    await temp.close();
  }
});
