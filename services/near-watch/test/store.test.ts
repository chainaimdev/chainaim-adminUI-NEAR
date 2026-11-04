import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeOutcome, neardataBlock } from "../src/decode.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, Store } from "../src/store.ts";
import { ctx, fixture as f, RECEIVER } from "./fixtures.ts";

const row = () => neardataBlock(f.neardata[String(f.receiptHeight)], f.contract).outcomes.flatMap((o) => decodeOutcome(o, ctx()))[0];

test("first road wins; a later road is recorded with its lag; the same road again is dropped", () => {
  const s = new Store(":memory:");
  const r = row();
  assert.equal(s.recordArrival(r, "neardata", 1000).kind, "first");
  const later = s.recordArrival(r, "qn-rpc", 1750);
  assert.equal(later.kind, "later");
  assert.equal(later.kind === "later" && later.lagMs, 750);
  assert.equal(s.recordArrival(r, "qn-rpc", 1800).kind, "repeat");
  assert.equal(s.getTx("testnet", r.hash)?.firstVia, "neardata");
  assert.deepEqual(s.roadsFor("testnet", r.hash).map((x) => x.via), ["neardata", "qn-rpc"]);
  assert.equal(s.roadStats("testnet").neardata.first, 1);
  assert.equal(s.roadStats("testnet")["qn-rpc"].total, 1);
  assert.equal(s.getTx("testnet", r.hash.toLowerCase()), undefined, "base58 hashes are case-sensitive");
  s.close();
});

test("cursors only move forward", () => {
  const s = new Store(":memory:");
  s.setCursor("testnet", "neardata", 100);
  s.setCursor("testnet", "neardata", 90);
  assert.equal(s.getCursor("testnet", "neardata"), 100);
  s.setCursor("testnet", "rpc", 120);
  assert.equal(s.maxCursor("testnet"), 120);
  s.close();
});

test("a schema-1 store (x402 judged by memo) is migrated: rows re-judged by the memo-free rule, invoice fields dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "near-watch-store-"));
  const path = join(dir, "v1.sqlite");
  try {
    // A schema-1 file as the previous build wrote it: the recorded payment stored as not-x402 (it has no memo).
    const old = { ...row(), isX402: false, invoiceId: null, invoiceMatches: false };
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE txs (network TEXT NOT NULL, hash TEXT NOT NULL, block_height INTEGER NOT NULL, block_time_ms INTEGER,
        first_via TEXT NOT NULL, first_seen_ms INTEGER NOT NULL, is_x402 INTEGER NOT NULL, invoice_id TEXT, row_json TEXT NOT NULL,
        PRIMARY KEY (network, hash));
      CREATE INDEX txs_invoice ON txs (invoice_id);
      INSERT INTO meta VALUES ('schema', '1');`);
    db.prepare("INSERT INTO txs VALUES (?, ?, ?, ?, 'neardata', 1, 0, NULL, ?)").run(old.network, old.hash, old.blockHeight, old.blockTimeMs, JSON.stringify(old));
    db.close();

    assert.throws(() => new Store(path), /schema 1/, "migrating needs the pay-to accounts");
    const s = new Store(path, { payTo: new Map([["testnet", new Set([RECEIVER])]]) });
    const tx = s.getTx("testnet", f.tx);
    assert.equal(tx?.row.isX402, true);
    assert.equal("invoiceId" in (tx?.row ?? {}), false);
    assert.equal(s.getMeta("schema"), String(SCHEMA_VERSION));
    assert.equal(s.openChainPayments("testnet", [RECEIVER], 0, 10).length, 1, "is_x402 column updated too");
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
