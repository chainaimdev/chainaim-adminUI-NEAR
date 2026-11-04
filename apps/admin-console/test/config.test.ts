/** CONSOLE-CONFIG: lib/config.ts (ported from liveops admin-console test/config.test.ts, NEAR_WATCH_URL in place of CONSOLE_LEDGER_WATCH_URL). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, DEFAULTS, loadConfig, parseNearWatchUrl } from "../lib/config.ts";

const KEY = "k".repeat(40);

test("CONSOLE-CONFIG defaults: loopback near-watch on 8790, key from ADMIN_API_KEY, timeouts", () => {
  const c = loadConfig({ ADMIN_API_KEY: KEY });
  assert.equal(DEFAULTS.nearWatchUrl, "http://127.0.0.1:8790");
  assert.equal(c.nearWatchUrl.href, "http://127.0.0.1:8790/");
  assert.equal(c.adminKeyEnv, "ADMIN_API_KEY");
  assert.equal(c.adminKey, KEY);
  assert.equal(c.upstreamTimeoutMs, 5000);
  assert.equal(c.connectTimeoutMs, 10000);
});

test("CONSOLE-CONFIG NEAR_WATCH_URL is read; the key variable is configurable; errors name the variable, never the value", () => {
  assert.equal(loadConfig({ ADMIN_API_KEY: KEY, NEAR_WATCH_URL: "http://localhost:9999" }).nearWatchUrl.href, "http://localhost:9999/");
  assert.equal(loadConfig({ CONSOLE_ADMIN_KEY_ENV: "NW_KEY", NW_KEY: KEY }).adminKey, KEY);
  assert.throws(() => loadConfig({}), (e: Error) => e instanceof ConfigError && /ADMIN_API_KEY is not set/.test(e.message));
  const short = "shortsecretvalue";
  assert.throws(
    () => loadConfig({ ADMIN_API_KEY: short }),
    (e: Error) => e instanceof ConfigError && /shorter than 24/.test(e.message) && !e.message.includes(short),
  );
  assert.throws(() => loadConfig({ CONSOLE_ADMIN_KEY_ENV: "bad name", ADMIN_API_KEY: KEY }), /not a valid variable name/);
});

test("CONSOLE-CONFIG near-watch URL: plain http only to loopback; https anywhere; no credentials or query", () => {
  assert.equal(parseNearWatchUrl("http://localhost:8790").href, "http://localhost:8790/");
  assert.equal(parseNearWatchUrl("https://watch.example.org/nw").href, "https://watch.example.org/nw/");
  assert.throws(() => parseNearWatchUrl("http://10.0.0.5:8790"), /must be loopback/);
  assert.throws(() => loadConfig({ ADMIN_API_KEY: KEY, NEAR_WATCH_URL: "http://10.0.0.5:8790" }), /NEAR_WATCH_URL over plain http must be loopback/);
  assert.throws(() => parseNearWatchUrl("ftp://127.0.0.1"), /http or https/);
  assert.throws(() => parseNearWatchUrl("http://u:p@127.0.0.1:8790"), /credentials/);
  assert.throws(() => parseNearWatchUrl("http://127.0.0.1:8790/?k=1"), /query/);
  assert.throws(() => parseNearWatchUrl("not a url"), /not a URL/);
});

test("CONSOLE-CONFIG timeouts are validated", () => {
  assert.equal(loadConfig({ ADMIN_API_KEY: KEY, CONSOLE_UPSTREAM_TIMEOUT_MS: "2500" }).upstreamTimeoutMs, 2500);
  assert.throws(() => loadConfig({ ADMIN_API_KEY: KEY, CONSOLE_CONNECT_TIMEOUT_MS: "5" }), /CONSOLE_CONNECT_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ ADMIN_API_KEY: KEY, CONSOLE_UPSTREAM_TIMEOUT_MS: "1.5" }), /whole number/);
});
