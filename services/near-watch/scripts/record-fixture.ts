/**
 * Record REAL testnet data for the protocol doubles in test/ (DESIGN §7: no hand-invented shapes).
 *
 *   node scripts/record-fixture.ts --tx <hash> --signer <account> --contract <usdc> [--rpc URL] [--neardata URL] [--name NAME]
 *
 * Saves test/fixtures/<name>.json with (every height from inclusion to the last USDC receipt):
 *   txStatus        RPC EXPERIMENTAL_tx_status (wait_until FINAL) of the transaction
 *   blocks          RPC `block` for the inclusion block and every block a USDC receipt executed in, keyed by hash
 *   inclusionHeight / receiptHeight
 *   chunks          RPC `chunk` for every chunk of the inclusion block with a non-empty tx_root, keyed by chunk hash
 *   neardata        neardata /v0/block/<receiptHeight> and /v0/block/<inclusionHeight>
 * The RPC URL defaults to the public archival testnet RPC (docs.near.org/api/rpc/providers; severely rate limited,
 * fine for one recording). Nothing secret is written: pass a QuickNode URL only if you accept its host in no file —
 * the URL itself is never saved.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { httpRpc } from "../src/rpc.ts";
import { EMPTY_ROOT } from "../src/feeds/rpc-poll.ts";
import { txStatusBlockHashes } from "../src/decode.ts";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : def;
  if (v === undefined) {
    process.stderr.write(`record-fixture: --${name} is required\n`);
    process.exit(2);
  }
  return v;
}

const tx = arg("tx");
const signer = arg("signer");
const contract = arg("contract");
const rpcUrl = arg("rpc", "https://archival-rpc.testnet.near.org");
const nd = arg("neardata", "https://testnet.neardata.xyz").replace(/\/+$/, "");
const name = arg("name", `usdc-transfer-${tx.slice(0, 8)}`);
const rpc = httpRpc("record", rpcUrl, { timeoutMs: 60_000 });

type Block = { header: { height: number; hash: string }; chunks: { chunk_hash: string; height_included: number; tx_root: string }[] };

const txStatus = await rpc.call<{ transaction_outcome: { block_hash: string } }>("EXPERIMENTAL_tx_status", { tx_hash: tx, sender_account_id: signer, wait_until: "FINAL" });
const blocks: Record<string, unknown> = {};
const inclusion = await rpc.call<Block>("block", { block_id: txStatus.transaction_outcome.block_hash });
blocks[inclusion.header.hash] = inclusion;
const receiptHashes = txStatusBlockHashes(txStatus, contract);
if (receiptHashes.length === 0) throw new Error(`${tx} has no receipt executed by ${contract}`);
let receiptHeight = 0;
for (const h of receiptHashes) {
  const b = await rpc.call<Block>("block", { block_id: h });
  blocks[b.header.hash] = b;
  receiptHeight = Math.max(receiptHeight, b.header.height);
}
// Every height from inclusion to the last USDC receipt: RPC block (null = no block at that height), its new chunks.
const skipped: number[] = [];
for (let h = inclusion.header.height + 1; h <= receiptHeight; h++) {
  try {
    const b = await rpc.call<Block>("block", { block_id: h });
    blocks[b.header.hash] = b;
  } catch (e) {
    if ((e as { cause_name?: string }).cause_name !== "UNKNOWN_BLOCK") throw e;
    skipped.push(h);
  }
}
const chunks: Record<string, unknown> = {};
for (const b of Object.values(blocks) as Block[]) {
  for (const c of b.chunks) {
    if (c.height_included !== b.header.height || c.tx_root === EMPTY_ROOT) continue;
    chunks[c.chunk_hash] = await rpc.call("chunk", { chunk_id: c.chunk_hash });
  }
}
const neardata: Record<string, unknown> = {};
for (let h = inclusion.header.height; h <= receiptHeight; h++) {
  let res = await fetch(`${nd}/v0/block/${h}`, { redirect: "follow" });
  // neardata allows 180 requests a minute without a key: wait and retry on 429.
  for (let tries = 0; res.status === 429 && tries < 6; tries++) {
    await new Promise((r) => setTimeout(r, 10_000));
    res = await fetch(`${nd}/v0/block/${h}`, { redirect: "follow" });
  }
  if (!res.ok) throw new Error(`neardata block ${h}: HTTP ${res.status}`);
  neardata[String(h)] = await res.json();
}
// View calls (state at recording time, finality final) for the accounts of the recorded transfer.
const views: Record<string, unknown> = {};
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64");
// The signer (for a NEP-366 delegate payment: the relayer) and both sides of the NEP-141 event.
const json = JSON.stringify(txStatus);
const owner = (k: string) => json.match(new RegExp(`${k}\\\\":\\\\"([^\\\\"]+)`))?.[1];
const accounts = [...new Set([signer, owner("old_owner_id"), owner("new_owner_id")].filter((a): a is string => typeof a === "string"))];
views[`call_function:${contract}:ft_metadata:${b64({})}`] = await rpc.call("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: "ft_metadata", args_base64: b64({}) });
for (const a of accounts) {
  for (const m of ["ft_balance_of", "storage_balance_of"]) {
    views[`call_function:${contract}:${m}:${b64({ account_id: a })}`] = await rpc.call("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: m, args_base64: b64({ account_id: a }) });
  }
  views[`view_account:${a}`] = await rpc.call("query", { request_type: "view_account", finality: "final", account_id: a });
}
const out = { recordedAt: new Date().toISOString(), source: { rpc: new URL(rpcUrl).host, neardata: new URL(nd).host }, network: "testnet", contract, tx, signer, inclusionHeight: inclusion.header.height, receiptHeight, skipped, txStatus, blocks, chunks, neardata, views };
const dir = new URL("../test/fixtures/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL(`${name}.json`, dir), `${JSON.stringify(out)}\n`);
process.stdout.write(`recorded ${name}.json: tx ${tx} included at ${inclusion.header.height}, USDC receipt at ${receiptHeight}, ${Object.keys(chunks).length} chunk(s)\n`);
