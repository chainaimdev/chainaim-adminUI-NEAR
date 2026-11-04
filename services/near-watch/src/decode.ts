/**
 * NEP-141 transfers out of NEAR receipt outcomes, as every road delivers them, turned into the Row the store,
 * the reconciler and the console share. docs/NEAR-GATES.md A2/A3 has the sources.
 *
 * What counts (GATE A2): a receipt executed by the token contract (`executor_id` == NEAR_USDC_CONTRACT — the
 * NEAR docs say to check the executor, since any contract can print the same log) whose outcome succeeded and
 * whose logs carry a NEP-297 event
 *   EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{old_owner_id,new_owner_id,amount,memo?}]}
 * Only transfers touching a watched account are kept. A failed `ft_transfer` / `ft_transfer_call` receipt to the
 * contract (no event: nothing moved) is kept as a `failure` row from its call arguments, so the console can show it;
 * it is never counted.
 *
 * Finality (GATE A3): receipts can execute in later blocks than their transaction. A row's block is the block in
 * which the transfer receipt executed, and a road only hands in outcomes from final blocks.
 *
 * x402 rule (DESIGN §5.1; docs/NEAR-GATES.md A7): a successful `ft_transfer` receipt of the watched token
 * (executor == NEAR_USDC_CONTRACT) with exactly one NEP-141 transfer event, into a watched pay-to. No memo is required
 * or read: the x402 NEAR exact scheme's delegate is `ft_transfer {receiver_id, amount}` and defines no memo
 * (chainiam-private-ai docs/NEAR-GATES.md G3; the recorded payment H3ZFsVY1… has none). The memo, when a transfer
 * carries one, is kept as data only. Claims join transfers by transaction hash alone (reconcile.ts).
 */
import { formatUnits, isUnits } from "../../../packages/chain-core/src/money.ts";
import { isAccountId, isNearHash } from "../../../packages/chain-core/src/near.ts";

/** One executed receipt, in the shape both neardata and the RPC roads reduce to. */
export type ReceiptOutcome = {
  txHash: string;
  /** Height and time (ms) of the block the receipt executed in. */
  blockHeight: number;
  blockTimeMs: number | null;
  receiptId: string;
  executorId: string;
  predecessorId: string | null;
  /** FunctionCall actions of the receipt (args still base64). */
  calls: { method: string; argsBase64: string | null }[];
  logs: string[];
  /** The outcome status object: {SuccessValue}, {SuccessReceiptId}, {Failure}. */
  status: unknown;
};

export type Row = {
  network: string;
  /** Transaction hash (base58, case-sensitive): the join key with the paywall's claim. */
  hash: string;
  blockHeight: number;
  blockTimeMs: number | null;
  receiptId: string;
  contract: string;
  method: string | null;
  from: string;
  to: string;
  /** Base units, integer string. */
  amount: string;
  /** The same as a decimal string (token decimals). */
  value: string;
  /** The NEP-141 memo when the transfer carries one (x402 NEAR payments carry none). Data only, never matched. */
  memo: string | null;
  status: "success" | "failure";
  /** Only final blocks are recorded (roads.ts refuses anything else). */
  final: boolean;
  isUsdc: boolean;
  isX402: boolean;
  /** NEP-141 transfer events in this receipt (an x402 payment has exactly one). */
  events: number;
};

export type DecodeContext = {
  network: string;
  usdcContract: string;
  decimals: number;
  /** Every watched account (any role). */
  watched: ReadonlySet<string>;
  /** Watched pay-to accounts. */
  payTo: ReadonlySet<string>;
};

export class DecodeError extends Error {}

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export type FtEvent = { from: string; to: string; amount: string; memo: string | null };

/** The nep141 ft_transfer entries in one log line, or [] when the line is not such an event. */
export function ftTransferEvents(log: string): FtEvent[] {
  if (!log.startsWith("EVENT_JSON:")) return [];
  let ev: unknown;
  try {
    ev = JSON.parse(log.slice("EVENT_JSON:".length));
  } catch {
    return [];
  }
  if (!isObj(ev) || ev.standard !== "nep141" || ev.event !== "ft_transfer" || !Array.isArray(ev.data)) return [];
  const out: FtEvent[] = [];
  for (const d of ev.data) {
    if (!isObj(d) || typeof d.old_owner_id !== "string" || typeof d.new_owner_id !== "string" || !isUnits(d.amount)) continue;
    out.push({ from: d.old_owner_id, to: d.new_owner_id, amount: BigInt(d.amount as string).toString(), memo: typeof d.memo === "string" ? d.memo : null });
  }
  return out;
}

export function isSuccess(status: unknown): boolean {
  return isObj(status) && ("SuccessValue" in status || "SuccessReceiptId" in status);
}

export function decodeArgs(b64: string | null): Obj | null {
  if (!b64) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

const TRANSFER_METHODS = new Set(["ft_transfer", "ft_transfer_call"]);

/** The rows (0 or 1) one receipt outcome yields for the watched accounts. */
export function decodeOutcome(o: ReceiptOutcome, ctx: DecodeContext): Row[] {
  if (!isNearHash(o.txHash)) throw new DecodeError(`receipt ${o.receiptId} has no base58 tx hash`);
  if (!Number.isSafeInteger(o.blockHeight) || o.blockHeight <= 0) throw new DecodeError(`receipt ${o.receiptId} has no block height`);
  if (o.executorId !== ctx.usdcContract) return [];
  const method = o.calls.find((c) => TRANSFER_METHODS.has(c.method))?.method ?? o.calls[0]?.method ?? null;
  const base = { network: ctx.network, hash: o.txHash, blockHeight: o.blockHeight, blockTimeMs: o.blockTimeMs, receiptId: o.receiptId, contract: o.executorId, method, final: true, isUsdc: true };

  if (isSuccess(o.status)) {
    const events = o.logs.flatMap(ftTransferEvents);
    // Prefer the transfer into a pay-to, then any involving a watched account.
    const pick = events.find((e) => ctx.payTo.has(e.to)) ?? events.find((e) => ctx.watched.has(e.to) || ctx.watched.has(e.from));
    if (!pick) return [];
    return [
      {
        ...base,
        from: pick.from,
        to: pick.to,
        amount: pick.amount,
        value: formatUnits(pick.amount, ctx.decimals),
        memo: pick.memo,
        status: "success",
        isX402: ctx.payTo.has(pick.to) && events.length === 1 && method === "ft_transfer",
        events: events.length,
      },
    ];
  }

  // Failed transfer call: nothing moved; keep it visible when it was aimed at a watched account.
  const call = o.calls.find((c) => TRANSFER_METHODS.has(c.method));
  if (!call) return [];
  const args = decodeArgs(call.argsBase64);
  const to = typeof args?.receiver_id === "string" ? args.receiver_id : null;
  const from = o.predecessorId;
  if (!to || !from || !(ctx.watched.has(to) || ctx.watched.has(from))) return [];
  const amount = isUnits(args?.amount) ? BigInt(args.amount as string).toString() : "0";
  const memo = typeof args?.memo === "string" ? args.memo : null;
  return [
    {
      ...base,
      method: call.method,
      from,
      to,
      amount,
      value: formatUnits(amount, ctx.decimals),
      memo,
      status: "failure",
      isX402: false,
      events: 0,
    },
  ];
}

// ---------- neardata block -> receipt outcomes ----------

/** ms since the epoch from a NEAR header's timestamp_nanosec (string) or timestamp (number). */
export function headerTimeMs(header: Obj): number | null {
  const ns = header.timestamp_nanosec;
  if (typeof ns === "string" && /^\d+$/.test(ns)) return Number(BigInt(ns) / 1_000_000n);
  if (typeof header.timestamp === "number") return Math.floor(header.timestamp / 1_000_000);
  return null;
}

function callsOf(receipt: unknown): { calls: ReceiptOutcome["calls"] } {
  const action = isObj(receipt) && isObj(receipt.Action) ? receipt.Action : null;
  const actions = action && Array.isArray(action.actions) ? action.actions : [];
  const calls: ReceiptOutcome["calls"] = [];
  for (const a of actions) {
    if (isObj(a) && isObj(a.FunctionCall) && typeof a.FunctionCall.method_name === "string") {
      calls.push({ method: a.FunctionCall.method_name, argsBase64: typeof a.FunctionCall.args === "string" ? a.FunctionCall.args : null });
    }
  }
  return { calls };
}

export type BlockSummary = { height: number; hash: string; timeMs: number | null; txCount: number | null; prevHeight: number | null };

/**
 * One neardata block (GET /v0/block/<height>): its summary and the receipt outcomes executed by `contract`.
 * Shape (recorded fixture test/fixtures/*.json): {block:{header}, shards:[{chunk:{transactions}|null,
 * receipt_execution_outcomes:[{receipt, execution_outcome:{id, outcome:{executor_id, logs, status}}, tx_hash}]}]}.
 */
export function neardataBlock(raw: unknown, contract: string): { block: BlockSummary; outcomes: ReceiptOutcome[] } {
  if (!isObj(raw) || !isObj(raw.block) || !isObj(raw.block.header) || !Array.isArray(raw.shards)) throw new DecodeError("neardata block has no block.header or shards");
  const header = raw.block.header;
  const height = header.height;
  if (typeof height !== "number" || !Number.isSafeInteger(height)) throw new DecodeError("neardata block has no height");
  const timeMs = headerTimeMs(header);
  let txCount = 0;
  const outcomes: ReceiptOutcome[] = [];
  for (const shard of raw.shards) {
    if (!isObj(shard)) continue;
    if (isObj(shard.chunk) && Array.isArray(shard.chunk.transactions)) txCount += shard.chunk.transactions.length;
    const list = Array.isArray(shard.receipt_execution_outcomes) ? shard.receipt_execution_outcomes : [];
    for (const r of list) {
      if (!isObj(r) || !isObj(r.execution_outcome) || !isObj(r.execution_outcome.outcome)) continue;
      const out = r.execution_outcome.outcome;
      if (out.executor_id !== contract) continue;
      const receipt = isObj(r.receipt) ? r.receipt : {};
      outcomes.push({
        txHash: typeof r.tx_hash === "string" ? r.tx_hash : "",
        blockHeight: height,
        blockTimeMs: timeMs,
        receiptId: String(r.execution_outcome.id ?? receipt.receipt_id ?? ""),
        executorId: out.executor_id as string,
        predecessorId: typeof receipt.predecessor_id === "string" ? receipt.predecessor_id : null,
        ...callsOf(receipt.receipt),
        logs: Array.isArray(out.logs) ? out.logs.filter((l): l is string => typeof l === "string") : [],
        status: out.status,
      });
    }
  }
  return { block: { height, hash: String(header.hash ?? ""), timeMs, txCount, prevHeight: typeof header.prev_height === "number" ? header.prev_height : null }, outcomes };
}

// ---------- RPC EXPERIMENTAL_tx_status -> receipt outcomes ----------

/**
 * Receipt outcomes of one transaction from RPC `EXPERIMENTAL_tx_status` (docs.near.org/api/rpc/transactions):
 * {transaction:{hash}, receipts:[{receipt_id, predecessor_id, receipt:{Action:{actions}}}],
 *  receipts_outcome:[{id, block_hash, outcome:{executor_id, logs, status}}]}.
 * Block heights come from `heightOf(block_hash)` (the caller resolves them with RPC `block`).
 */
export function txStatusOutcomes(raw: unknown, contract: string, heightOf: (blockHash: string) => { height: number; timeMs: number | null } | undefined): ReceiptOutcome[] {
  if (!isObj(raw) || !isObj(raw.transaction) || typeof raw.transaction.hash !== "string") throw new DecodeError("tx status has no transaction.hash");
  const txHash = raw.transaction.hash;
  const receipts = new Map<string, Obj>();
  for (const r of Array.isArray(raw.receipts) ? raw.receipts : []) if (isObj(r) && typeof r.receipt_id === "string") receipts.set(r.receipt_id, r);
  const out: ReceiptOutcome[] = [];
  for (const ro of Array.isArray(raw.receipts_outcome) ? raw.receipts_outcome : []) {
    if (!isObj(ro) || !isObj(ro.outcome) || ro.outcome.executor_id !== contract || typeof ro.block_hash !== "string") continue;
    const h = heightOf(ro.block_hash);
    if (!h) throw new DecodeError(`tx ${txHash}: block ${ro.block_hash} height unknown`);
    const receipt = receipts.get(String(ro.id)) ?? {};
    out.push({
      txHash,
      blockHeight: h.height,
      blockTimeMs: h.timeMs,
      receiptId: String(ro.id),
      executorId: contract,
      predecessorId: typeof receipt.predecessor_id === "string" ? receipt.predecessor_id : null,
      ...callsOf(receipt.receipt),
      logs: Array.isArray(ro.outcome.logs) ? ro.outcome.logs.filter((l): l is string => typeof l === "string") : [],
      status: ro.outcome.status,
    });
  }
  return out;
}

/** The block hashes `txStatusOutcomes` will ask about for this contract. */
export function txStatusBlockHashes(raw: unknown, contract: string): string[] {
  if (!isObj(raw)) return [];
  const set = new Set<string>();
  for (const ro of Array.isArray(raw.receipts_outcome) ? raw.receipts_outcome : []) {
    if (isObj(ro) && isObj(ro.outcome) && ro.outcome.executor_id === contract && typeof ro.block_hash === "string") set.add(ro.block_hash);
  }
  return [...set];
}

/** A FunctionCall action that is a transfer naming a watched receiver. */
function transferToWatched(a: unknown, watched: ReadonlySet<string>): boolean {
  if (!isObj(a) || !isObj(a.FunctionCall) || !TRANSFER_METHODS.has(String(a.FunctionCall.method_name))) return false;
  const args = decodeArgs(typeof a.FunctionCall.args === "string" ? a.FunctionCall.args : null);
  return typeof args?.receiver_id === "string" && watched.has(args.receiver_id);
}

/**
 * Transactions in an RPC `chunk` result worth a status lookup: signed by or sent to a watched account; sent to the
 * token contract with a transfer call that names a watched receiver; or carrying a NEP-366 `Delegate` action whose
 * inner actions do that. The last is how an x402 NEAR payment arrives: a relayer signs a transaction to the buyer
 * holding `Delegate {delegate_action: {receiver_id: <token>, actions: [ft_transfer]}}` (recorded fixture H3ZFsVY1…).
 */
export function candidateTxs(chunk: unknown, contract: string, watched: ReadonlySet<string>): { hash: string; signer: string }[] {
  if (!isObj(chunk) || !Array.isArray(chunk.transactions)) return [];
  const out: { hash: string; signer: string }[] = [];
  for (const t of chunk.transactions) {
    if (!isObj(t) || typeof t.hash !== "string" || typeof t.signer_id !== "string" || !isAccountId(t.signer_id)) continue;
    // A transaction signed by, or sent to, a watched account may move USDC through a contract (relayer, multisig,
    // router: the recorded fixture is a relayer calling the sender's contract), so it is looked up too.
    if (watched.has(t.signer_id) || (typeof t.receiver_id === "string" && watched.has(t.receiver_id))) {
      out.push({ hash: t.hash, signer: t.signer_id });
      continue;
    }
    const actions = Array.isArray(t.actions) ? t.actions : [];
    const direct = t.receiver_id === contract && actions.some((a) => transferToWatched(a, watched));
    const delegated = actions.some((a) => {
      const d = isObj(a) && isObj(a.Delegate) && isObj(a.Delegate.delegate_action) ? a.Delegate.delegate_action : null;
      return d !== null && d.receiver_id === contract && Array.isArray(d.actions) && d.actions.some((x) => transferToWatched(x, watched));
    });
    if (direct || delegated) out.push({ hash: t.hash, signer: t.signer_id });
  }
  return out;
}
