import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { temporary } from "./helpers.ts";

test("CLI help and parsing create no config or state in an isolated home", async () => {
  const temp = await temporary();
  try {
    const env = {
      ...process.env,
      HOME: temp.path,
      XDG_CONFIG_HOME: temp.path,
      XDG_DATA_HOME: temp.path,
    };
    const run = (args: string[]) =>
      execFileSync(
        process.execPath,
        ["--experimental-strip-types", "src/cli.ts", ...args],
        { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    assert.match(run(["--help"]), /connect\|serve/);
    assert.match(
      run([
        "--config",
        join(temp.path, "does-not-exist", "config.json"),
        "--help",
      ]),
      /Node >=24.15/,
    );
    assert.throws(
      () => run(["unknown"]),
      (e) => {
        assert.ok(e && typeof e === "object" && "stderr" in e);
        assert.match(String(e.stderr), /Use connect or serve/);
        return true;
      },
    );
    assert.deepEqual(readdirSync(temp.path), []);
  } finally {
    await temp.close();
  }
});
