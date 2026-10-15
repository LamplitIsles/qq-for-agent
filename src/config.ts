import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const secret = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !/[\r\n]/.test(v));
export const configSchema = z
  .object({
    app_id: z.string().regex(/^[a-zA-Z0-9_-]{1,255}$/),
    app_secret: secret,
    gateway_token: secret.refine((v) => !/\s/.test(v)),
    port: z.number().int().min(0).max(65535).default(8787),
    webhook: z
      .object({
        url: z
          .url()
          .refine(
            (v) =>
              ["http:", "https:"].includes(new URL(v).protocol) &&
              !new URL(v).username &&
              !new URL(v).password,
          ),
        bearer: secret.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((c) => c.gateway_token !== c.app_secret);
export type Config = z.infer<typeof configSchema>;
export class SafeError extends Error {}
export function configPath(path?: string) {
  return resolve(
    path ?? join(homedir(), ".local", "share", "qq-for-agent", "config.json"),
  );
}
export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
export function readConfig(path: string): Config {
  try {
    const config = configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    privateDirectory(dirname(path));
    chmodSync(path, 0o600);
    return config;
  } catch {
    throw new SafeError("Cannot read valid private configuration");
  }
}
export function writeCredentials(
  path: string,
  appId: string,
  appSecret: string,
) {
  const c = configSchema.parse({
    app_id: appId,
    app_secret: appSecret,
    gateway_token: randomBytes(32).toString("hex"),
  });
  privateDirectory(dirname(path));
  // Exclusive creation also protects against another connect finishing first.
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(c, null, 2) + "\n");
  } finally {
    closeSync(fd);
  }
}
export function assertNewConfig(path: string) {
  if (existsSync(path))
    throw new SafeError(
      "Configuration already exists; use serve or a different private config path",
    );
}
