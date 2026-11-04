import assert from "node:assert/strict";
import { test } from "node:test";
import { isCaip2 } from "../src/caip.ts";
import { compareUnits, formatUnits, parseUnits, sumUnits, toUnits } from "../src/money.ts";
import { isAccountId, isNearHash } from "../src/near.ts";
import { redactUrl, scrub } from "../src/redact.ts";

test("money: base units <-> decimal with bigint", () => {
  assert.equal(formatUnits("10000", 6), "0.01");
  assert.equal(formatUnits("4500000", 6), "4.5");
  assert.equal(formatUnits("0", 6), "0");
  assert.equal(toUnits("0.01", 6), "10000");
  assert.equal(toUnits("12", 6), "12000000");
  assert.throws(() => toUnits("0.0000001", 6));
  assert.throws(() => parseUnits("1.5"));
  assert.equal(sumUnits(["1", "2", "99999999999999999999"]), "100000000000000000002");
  assert.equal(compareUnits("10", "9"), 1);
  assert.equal(formatUnits("10010820886704223599999993", 24), "10.010820886704223599999993");
});

test("redaction never shows a path, query or token", () => {
  assert.equal(redactUrl("https://abc.near-testnet.quiknode.pro/0123456789abcdef/"), "https://abc.near-testnet.quiknode.pro/…");
  assert.equal(redactUrl("https://testnet.neardata.xyz/v0/block/1?apiKey=secret"), "https://testnet.neardata.xyz/…");
  assert.equal(redactUrl("https://test.rpc.fastnear.com"), "https://test.rpc.fastnear.com");
  assert.equal(scrub("fetch failed for https://x.quiknode.pro/tok3n123/ now", ["https://x.quiknode.pro/tok3n123/"]), "fetch failed for *** now");
});

test("ids", () => {
  assert.ok(isAccountId("near-stocks-user1.testnet"));
  assert.ok(isAccountId("3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"));
  assert.ok(!isAccountId("Bad.testnet"));
  assert.ok(isNearHash("F2wHrmW1TGqg59xDbUiR2SqXF2MPuivnod4TcE1FvR84"));
  assert.ok(!isNearHash("0".repeat(64)));
  assert.ok(isCaip2("near:testnet"));
  assert.ok(!isCaip2("near"));
});
