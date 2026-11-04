/**
 * Server-side configuration of the console (ported from liveops admin-console lib/config.ts). Read by the API routes
 * at request time and by scripts/console.ts at start-up (so a bad setting stops the launcher before Next.js starts).
 * Never imported by a client component: the admin key must not reach a browser bundle.
 *
 *   NEAR_WATCH_URL                near-watch base URL (default http://127.0.0.1:8790); plain http only to loopback
 *   CONSOLE_ADMIN_KEY_ENV         NAME of the variable holding near-watch's admin key (default ADMIN_API_KEY)
 *   CONSOLE_UPSTREAM_TIMEOUT_MS   one REST call to near-watch (default 5000)
 *   CONSOLE_CONNECT_TIMEOUT_MS    time for near-watch to start answering /stream (default 10000)
 *
 * Error messages name variables, never their values.
 */
export const DEFAULTS = {
  nearWatchUrl: "http://127.0.0.1:8790",
  adminKeyEnv: "ADMIN_API_KEY",
  upstreamTimeoutMs: 5000,
  connectTimeoutMs: 10000,
} as const;

/** near-watch refuses admin keys shorter than this (services/near-watch src/config.ts). */
export const MIN_ADMIN_KEY_LENGTH = 24;

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export type ConsoleConfig = {
  nearWatchUrl: URL;
  adminKeyEnv: string;
  adminKey: string;
  upstreamTimeoutMs: number;
  connectTimeoutMs: number;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

function wholeNumber(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/** Validates a near-watch base URL: http or https, no credentials, no query; plain http only to loopback. */
export function parseNearWatchUrl(raw: string, name = "NEAR_WATCH_URL"): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ConfigError(`${name} must be http or https`);
  if (u.username || u.password) throw new ConfigError(`${name} must not hold credentials`);
  if (u.search || u.hash) throw new ConfigError(`${name} must not have a query or fragment`);
  if (u.protocol === "http:" && !LOOPBACK_HOSTS.has(u.hostname)) {
    throw new ConfigError(`${name} over plain http must be loopback (the admin key would travel unencrypted)`);
  }
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  return u;
}

export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name);
}

export function loadConfig(env: Env = process.env): ConsoleConfig {
  const nearWatchUrl = parseNearWatchUrl(env.NEAR_WATCH_URL?.trim() || DEFAULTS.nearWatchUrl);
  const adminKeyEnv = env.CONSOLE_ADMIN_KEY_ENV?.trim() || DEFAULTS.adminKeyEnv;
  if (!isValidEnvName(adminKeyEnv)) throw new ConfigError("CONSOLE_ADMIN_KEY_ENV is not a valid variable name");
  const adminKey = env[adminKeyEnv]?.trim() ?? "";
  if (adminKey === "") throw new ConfigError(`${adminKeyEnv} is not set (start the console with --env-file=<private env>)`);
  if (adminKey.length < MIN_ADMIN_KEY_LENGTH) throw new ConfigError(`${adminKeyEnv} is shorter than ${MIN_ADMIN_KEY_LENGTH} characters`);
  return {
    nearWatchUrl,
    adminKeyEnv,
    adminKey,
    upstreamTimeoutMs: wholeNumber(env, "CONSOLE_UPSTREAM_TIMEOUT_MS", DEFAULTS.upstreamTimeoutMs, 100, 120_000),
    connectTimeoutMs: wholeNumber(env, "CONSOLE_CONNECT_TIMEOUT_MS", DEFAULTS.connectTimeoutMs, 100, 120_000),
  };
}
