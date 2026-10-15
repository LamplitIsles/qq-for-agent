import { startQrConnect } from "@tencent-connect/qqbot-connector";
import { assertNewConfig, SafeError, writeCredentials } from "./config.ts";

export async function connect(
  path: string,
  signal: AbortSignal,
  start: typeof startQrConnect = startQrConnect,
  log = console.error,
) {
  assertNewConfig(path);
  if (signal.aborted) throw new SafeError("Connect cancelled");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stop: (() => void) | undefined;
    const finish = (error?: SafeError) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancelled);
      stop?.();
      error ? reject(error) : resolve();
    };
    const cancelled = () => finish(new SafeError("Connect cancelled"));
    signal.addEventListener("abort", cancelled, { once: true });
    try {
      stop = start(
        {
          onSuccess(credentials) {
            if (settled || signal.aborted) return;
            if (credentials.length !== 1) {
              finish(
                new SafeError(
                  "Expected exactly one QQ App; configure an existing App explicitly",
                ),
              );
              return;
            }
            try {
              writeCredentials(
                path,
                credentials[0].appId,
                credentials[0].appSecret,
              );
              finish();
            } catch {
              finish(
                new SafeError(
                  "Could not create private configuration; existing configuration is never overwritten",
                ),
              );
            }
          },
          onFailure() {
            finish(new SafeError("QQ connect failed or cancelled"));
          },
          onQrExpired() {
            if (!settled) log("QR expired; connector is refreshing it");
          },
        },
        { displayQrCodeToConsole: true, signal, source: "qq-for-agent" },
      );
      if (settled) stop();
    } catch {
      finish(new SafeError("QQ connect failed"));
    }
  });
}
