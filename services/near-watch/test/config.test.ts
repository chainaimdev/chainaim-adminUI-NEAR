/**
 * The NEAR CAIP-2 default (docs/NEAR-GATES.md A5, closed by chainiam-private-ai NEAR-GATES G4): near-watch must accept
 * exactly the `network` the paywall writes in payment_settled, with no NEAR_CAIP2_<NET> set.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseClaim } from "../src/claims.ts";
import { ConfigError, loadConfig, NEAR_CAIP2_DEFAULT } from "../src/config.ts";
import { AMOUNT, fixture as fx, SENDER } from "./fixtures.ts";

const BASE = { ADMIN_API_KEY: "admin-key-for-tests-0123456789", NEAR_USDC_CONTRACT_TESTNET: fx.contract, NEAR_USDC_CONTRACT_MAINNET: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" };

/** What the paywall's NEAR rail writes: payment_settled.network = NEAR_NETWORKS[NEAR_NETWORK] (G4; @x402/near's ids). */
const PAYWALL_WRITES = { testnet: "near:testnet", mainnet: "near:mainnet" } as const;

/** The paywall's own table, read from the sibling checkout (chainiam-private-ai) when it is there. */
const PAYWALL_CONFIG = new URL("../../../../chainiam-private-ai/services/paywall/src/config.ts", import.meta.url);

const claimFrom = (network: string) => ({ ts: "2026-11-04T10:00:00.000Z", event: "payment_settled", route: "POST /v1/chat", amount: AMOUNT, asset: fx.contract, network, payer: SENDER, transaction: fx.tx });

test("CAIP-2 defaults to near:testnet / near:mainnet with NEAR_CAIP2_<NET> unset", () => {
  assert.equal(loadConfig([], BASE).caip2, "near:testnet");
  assert.equal(loadConfig(["--network", "mainnet"], BASE).caip2, "near:mainnet");
  assert.deepEqual(NEAR_CAIP2_DEFAULT, PAYWALL_WRITES);
});

test("the default equals what the paywall writes: its claim line is accepted with no env var set", () => {
  for (const net of ["testnet", "mainnet"] as const) {
    const cfg = loadConfig(["--network", net], BASE);
    const claim = parseClaim(claimFrom(PAYWALL_WRITES[net]), { [cfg.caip2]: cfg.network });
    assert.equal(claim.network, net);
  }
});

test("the default equals the paywall's own NEAR_NETWORKS table (sibling checkout)", (t) => {
  if (!existsSync(PAYWALL_CONFIG)) return t.skip("chainiam-private-ai is not checked out next to this repo; the pinned values above still apply");
  const src = readFileSync(PAYWALL_CONFIG, "utf8");
  const table = src.match(/export const NEAR_NETWORKS = \{([^}]*)\}/)?.[1];
  assert.ok(table, "NEAR_NETWORKS in the paywall's config.ts");
  const ids = Object.fromEntries([...table.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(ids, NEAR_CAIP2_DEFAULT);
});

test("NEAR_CAIP2_<NET> is still an optional override, and must be a near: CAIP-2 id", () => {
  assert.equal(loadConfig([], { ...BASE, NEAR_CAIP2_TESTNET: "near:custom" }).caip2, "near:custom");
  assert.equal(loadConfig([], { ...BASE, NEAR_CAIP2_TESTNET: "  " }).caip2, "near:testnet", "blank = unset");
  assert.throws(() => loadConfig([], { ...BASE, NEAR_CAIP2_TESTNET: "eip155:1" }), ConfigError);
});
