/**
 * Starts the NEAR Live Ops console (Next.js; ported from liveops admin-console scripts/console.ts) with its settings as flags, checked before Next.js starts.
 *
 *   node --env-file=C:\PRIV-AI-SECRETS\near-watch.env scripts/console.ts \
 *     [--mode dev|start]                         dev = next dev; start = next start (needs `npm run build` first)
 *     [--port 8800] [--bind 127.0.0.1]           where the console listens; loopback only
 *     [--near-watch-url http://127.0.0.1:8790]   near-watch base URL (env NEAR_WATCH_URL); plain http only to loopback
 *     [--admin-key-env ADMIN_API_KEY]            NAME of the variable holding near-watch's admin key
 *     [--upstream-timeout-ms 5000] [--connect-timeout-ms 10000]
 *
 * The key is read from the environment (never a flag, so it never lands in shell history) and only by the
 * console's server; the browser is given /api/watch/... and nothing else.
 * Note: `node --env-file` does not replace a variable already set in the shell; an old value set there wins.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError, DEFAULTS, isValidEnvName, loadConfig, LOOPBACK_HOSTS } from "../lib/config.ts";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `node scripts/console.ts [--mode dev|start] [--port 8800] [--bind 127.0.0.1]
  [--near-watch-url ${DEFAULTS.nearWatchUrl}] [--admin-key-env ${DEFAULTS.adminKeyEnv}]
  [--upstream-timeout-ms ${DEFAULTS.upstreamTimeoutMs}] [--connect-timeout-ms ${DEFAULTS.connectTimeoutMs}]
`;

function fail(message: string): never {
  process.stderr.write(`console: ${message}\n`);
  process.exit(2);
}

function main(): void {
  let values;
  try {
    ({ values } = parseArgs({
      strict: true,
      options: {
        mode: { type: "string", default: "dev" },
        port: { type: "string", default: "8800" },
        bind: { type: "string", default: "127.0.0.1" },
        "near-watch-url": { type: "string", default: DEFAULTS.nearWatchUrl },
        "admin-key-env": { type: "string", default: DEFAULTS.adminKeyEnv },
        "upstream-timeout-ms": { type: "string", default: String(DEFAULTS.upstreamTimeoutMs) },
        "connect-timeout-ms": { type: "string", default: String(DEFAULTS.connectTimeoutMs) },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (e) {
    fail(`${(e as Error).message}\n${USAGE}`);
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.mode !== "dev" && values.mode !== "start") fail("--mode must be dev or start");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port must be a whole number from 1 to 65535");
  if (!LOOPBACK_HOSTS.has(values.bind)) fail("--bind must be a loopback address (127.0.0.1, ::1 or localhost): the console has no login yet");
  if (!isValidEnvName(values["admin-key-env"])) fail("--admin-key-env is not a valid variable name");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEAR_WATCH_URL: values["near-watch-url"],
    CONSOLE_ADMIN_KEY_ENV: values["admin-key-env"],
    CONSOLE_UPSTREAM_TIMEOUT_MS: values["upstream-timeout-ms"],
    CONSOLE_CONNECT_TIMEOUT_MS: values["connect-timeout-ms"],
    NEXT_TELEMETRY_DISABLED: "1",
  };
  let cfg;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) fail(e.message);
    throw e;
  }
  if (values.mode === "start" && !existsSync(join(APP_DIR, ".next", "BUILD_ID"))) fail("no production build: run `npm run build` first, or use --mode dev");

  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  process.stdout.write(
    `console: ${values.mode} on http://${values.bind}:${port}  near-watch ${cfg.nearWatchUrl.origin}  admin key from ${cfg.adminKeyEnv}\n`,
  );
  const child = spawn(process.execPath, [nextBin, values.mode, "--port", String(port), "--hostname", values.bind], { cwd: APP_DIR, env, stdio: "inherit" });
  const forward = (signal: NodeJS.Signals): void => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on("error", (e) => fail(`could not start Next.js: ${e.message}`));
}

main();
