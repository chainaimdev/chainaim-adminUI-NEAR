/** CONSOLE-FORMAT: lib/format.ts (ported from liveops format + time-zone tests). Money stays a string; base units go through bigint. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { account, age, blockHeight, clock, decimals, DISPLAY_TIME_ZONE, money, ratios, ROAD_CLASS, ROAD_LABELS, short, stamp, sumDecimal, unitsToDecimal } from "../lib/format.ts";
import { ROADS } from "../lib/types.ts";

test("CONSOLE-FORMAT ages: seconds, minutes, hours; a small negative skew reads as 0; garbage reads as a dash", () => {
  assert.equal(age(400), "0.4 s");
  assert.equal(age(12_400), "12 s");
  assert.equal(age(180_000), "3 min");
  assert.equal(age(7_200_000), "2 h");
  assert.equal(age(-35), "0.0 s");
  assert.equal(age(null), "—");
  assert.equal(age(Number.NaN), "—");
});

test("CONSOLE-FORMAT block height, money, short ids and NEAR account ids", () => {
  assert.equal(blockHeight(270414460), "270,414,460");
  assert.equal(blockHeight(null), "—");
  assert.equal(money("4.5"), "4.5");
  assert.equal(money("1e-8"), "—");
  assert.equal(short("F2wHrmW1TGqg59xDbUiR2SqXF2MPuivnod4TcE1FvR84", 6, 4), "F2wHrm…vR84", "case kept");
  assert.equal(account("near-stocks-user1.testnet"), "near-stocks-user1.testnet", "named accounts are kept whole");
  assert.equal(account("3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"), "3e2210e1…fcb8af", "64-hex implicit accounts are shortened");
  assert.equal(account(null), "—");
});

test("CONSOLE-FORMAT decimal sums are exact and keep money as strings", () => {
  assert.equal(sumDecimal(["0.01", "0.02", "0.1"]), "0.13");
  assert.equal(sumDecimal(["0.1", "0.2"]), "0.3");
  assert.equal(sumDecimal([]), "0");
  assert.equal(sumDecimal(["1e-8", null, "2"]), "2");
  assert.equal(sumDecimal(["-0.5", "0.25"]), "-0.25");
  assert.equal(decimals("1234.5"), "1,234.50");
  assert.equal(decimals("0.000001"), "0.000001");
  assert.equal(decimals("bad"), "—");
});

test("CONSOLE-UNITS claim base units become decimals by bigint with the token's decimals; unknown decimals give null", () => {
  assert.equal(unitsToDecimal("4500000", 6), "4.5", "the recorded 4.5 USDC transfer");
  assert.equal(unitsToDecimal("10000", 6), "0.01");
  assert.equal(unitsToDecimal("0", 6), "0");
  assert.equal(unitsToDecimal("123456789012345678901234567890", 24), "123456.78901234567890123456789", "beyond float precision");
  assert.equal(unitsToDecimal("7", 0), "7");
  assert.equal(unitsToDecimal("4500000", null), null);
  assert.equal(unitsToDecimal("4.5", 6), null, "a decimal is not base units");
  assert.equal(unitsToDecimal("-1", 6), null);
});

test("CONSOLE-RATIOS bar heights are computed by bigint; the largest is 1, invalid reads 0", () => {
  assert.deepEqual(ratios(["4.5", "2.25", "0", "bad"]), [1, 0.5, 0, 0]);
  assert.deepEqual(ratios(["0.000001", "0.000002"]), [0.5, 1]);
  assert.deepEqual(ratios([]), []);
  assert.deepEqual(ratios(["0", "0"]), [0, 0]);
});

test("CONSOLE-ROADS every near-watch road has a plain-words label and a chip class", () => {
  assert.deepEqual([...ROADS], ["neardata", "qn-rpc", "rpc", "backfill"]);
  for (const r of ROADS) {
    assert.ok(ROAD_LABELS[r].length > 0, r);
    assert.ok(ROAD_CLASS[r].length > 0, r);
  }
  assert.match(ROAD_LABELS.neardata, /neardata/);
  assert.match(ROAD_LABELS["qn-rpc"], /QuickNode/);
});

test("UTC-DISPLAY clock() shows date, 24 h time and UTC, never the machine's zone", () => {
  assert.equal(DISPLAY_TIME_ZONE, "UTC");
  const t = Date.UTC(2026, 9, 30, 6, 31, 8);
  assert.equal(clock(t), "30 Oct, 06:31:08 UTC");
  assert.equal(stamp(t), clock(t));
  assert.equal(clock(Date.UTC(2026, 9, 29, 23, 59, 59)), "29 Oct, 23:59:59 UTC");
  assert.equal(clock(null), "—");
  assert.equal(clock(Number.NaN), "—");
});
