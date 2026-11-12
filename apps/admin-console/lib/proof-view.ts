/**
 * The signed quote and the signed receipt of a paid job, for the Jobs tab (ARCH-703; near-watch ARCH-701 job_receipt and
 * ARCH-702 job_quoted.ap2; private-ai privateAI-design-33 section 7, design-32 ARCH-615). Pure: it only reads JobView.
 *
 * What each proves, said plainly in the titles: the signed quote = ChainAim's console signed the quote as a UCP checkout
 * (AP2 merchant authorization, ES256) and the buyer's agent can check it with its pinned key; near-watch holds only the key
 * id and the signature's hash. The receipt = the console signed what the job ran on (file, query and result hashes) and,
 * once settled, the transaction that paid for it. Neither is re-verified here: near-watch never holds a signature or key.
 */
import { short } from "./format.ts";
import type { JobView } from "./types.ts";

export type ProofCell = { mark: string; text: string; tone: "ok" | "warn" | "none"; title: string };

/** The "signed quote" column: ✓ and the key id, or – when the quote was not signed (console on --ap2 off) or not reported. */
export function signedQuoteCell(j: JobView): ProofCell {
  const q = j.signedQuote;
  if (!q) return { mark: "–", text: "", tone: "none", title: "No signed quote reported (the console runs with --ap2 off, or this job was quoted before)" };
  return { mark: "✓", text: `${q.kid.slice(0, 8)}…`, tone: "ok", title: `Quote signed by ChainAim (AP2 merchant authorization, ES256) · key id ${q.kid} · signature sha256 ${q.merchantAuthSha256}` };
}

/** The "receipt" column: ✓ settled, pending (signed before its settlement was attached), or – (none reported). */
export function receiptCell(j: JobView): ProofCell {
  const r = j.receipt;
  if (!r) return { mark: "–", text: "", tone: "none", title: "No signed receipt reported (receipts off, the job is not released yet, or the console does not send job_receipt)" };
  if (!r.settled) return { mark: "⧗", text: "pending", tone: "warn", title: `Receipt ${r.receiptId} signed by key ${r.keyId}; its settlement is not attached yet` };
  return { mark: "✓", text: "settled", tone: "ok", title: `Receipt ${r.receiptId} signed by key ${r.keyId}; settlement transaction ${r.transaction}` };
}

/** The job detail rows (label, value, full value for the title). Empty when the job has neither. */
export function proofRows(j: JobView): [string, string, string][] {
  const rows: [string, string, string][] = [];
  if (j.signedQuote) {
    rows.push(["quote signing key id", j.signedQuote.kid, j.signedQuote.kid]);
    rows.push(["quote hash (merchantAuthSha256)", short(j.signedQuote.merchantAuthSha256, 12, 6), j.signedQuote.merchantAuthSha256]);
  }
  if (j.receipt) {
    rows.push(["receipt id", j.receipt.receiptId, j.receipt.receiptId]);
    rows.push(["receipt signing key id", j.receipt.keyId, j.receipt.keyId]);
    rows.push(["result hash", short(j.receipt.resultSha256, 12, 6), j.receipt.resultSha256]);
    rows.push(["files root", short(j.receipt.filesRoot, 12, 6), j.receipt.filesRoot]);
    rows.push(["receipt settlement", j.receipt.transaction ? short(j.receipt.transaction, 8, 6) : "not attached yet", j.receipt.transaction ?? ""]);
  }
  return rows;
}
