/**
 * NEAR AI model attestation in plain words, shared by every tab (owner 2026-11-07): Jobs, Live ops, Ledger, Reconcile,
 * Seller wallet. Pure: it only reads JobView (near-watch's job, with the console's job_attested when stored) and joins
 * by the job's settlement tx hash, the same key the ledger, the claims and the reconcile rows use.
 *
 * What a verdict proves: the bytes private-ai's gateway sent to NEAR AI (already masked) and the reply it got were
 * processed and signed inside an attested enclave (Intel TDX, NVIDIA GPU when checked). It never says the answer is right.
 */
import { short } from "./format.ts";
import type { AttestedCall, JobView } from "./types.ts";

export type AttestTone = "ok" | "warn" | "bad" | "none";
/** label: a few words for a table cell; sentence: what it means; action: what the operator does (null = nothing). */
export type AttestView = { tone: AttestTone; label: string; sentence: string; action: string | null };

const attestable = (calls: readonly AttestedCall[]) => calls.filter((c) => c.status !== "not_applicable");
const verifiedOf = (calls: readonly AttestedCall[]) => calls.filter((c) => c.status === "verified");

/** What the operator does about one call's reason (ca-attest's reason text, judge.ts). */
export function actionFor(c: AttestedCall): string | null {
  if (c.status === "verified" || c.status === "not_applicable") return null;
  const r = c.reason ?? "";
  if (c.status === "unavailable") return "re-checked automatically; nothing to do unless it stays like this";
  if (/gateway, not by the model's TEE/.test(r)) return "the model was not served from an enclave: do not claim attestation for this job";
  if (/hash mismatch/.test(r)) return "the bytes changed between ChainAim and the model: investigate before relying on this job";
  if (/does not recover|could not be recovered/.test(r)) return "the signature does not match the enclave's key: investigate";
  if (/no report|report/.test(r)) return "no verified enclave report before the call: check ca-attest's reports (Feeds tab)";
  return "see the reason; re-check the chat id at cloud.near.ai/verify";
}

/** One call in one sentence. */
export function callSentence(c: AttestedCall): string {
  const who = `The ${c.step} step (${c.model})`;
  if (c.status === "not_applicable") return `${who} has no enclave proof: only NEAR AI models can be attested.`;
  if (c.status === "unavailable") return `${who}: evidence not ready yet${c.reason && c.reason !== "checking" ? ` (${c.reason})` : ""}.`;
  if (c.status === "unverified") return `${who} was NOT verified: ${c.reason ?? "no reason given"}.`;
  const gpu = c.gpu === true ? " and its NVIDIA GPU proof" : c.gpu === null ? " (GPU not checked)" : " but its NVIDIA GPU proof failed";
  const signer = c.signingAddress ? ` by ${short(c.signingAddress, 8, 6)}` : "";
  return `${who} ran in a NEAR AI enclave: its Intel TDX quote${gpu} were checked; the reply was signed inside the enclave${signer}; the signed bytes ${c.hashes === false ? "do NOT match" : "match"} what the gateway sent and received.`;
}

/** The job's verdict in plain words; null when near-watch holds no attestation for it (yet). */
export function attestView(job: JobView | undefined | null): AttestView | null {
  const a = job?.attestation;
  if (!a) return null;
  const all = attestable(a.calls), ok = verifiedOf(a.calls);
  const na = a.calls.length - all.length;
  const tail = na ? ` · ${na} not attestable` : "";
  const sentence = a.calls.map(callSentence).join(" ");
  const firstBad = a.calls.find((c) => c.status === "unverified") ?? a.calls.find((c) => c.status === "unavailable");
  switch (a.summary) {
    case "attested": return { tone: "ok", label: `Verified · ${ok.length}/${all.length} NEAR AI${tail}`, sentence, action: null };
    case "partial": return { tone: "warn", label: `Partly verified · ${ok.length}/${all.length} NEAR AI${tail}`, sentence, action: firstBad ? actionFor(firstBad) : null };
    case "unverified": return { tone: "bad", label: `Not verified · ${firstBad?.reason ?? "see the calls"}`, sentence, action: firstBad ? actionFor(firstBad) : null };
    case "unavailable": return { tone: "warn", label: "Pending: evidence not ready", sentence, action: "re-checked automatically; nothing to do unless it stays like this" };
    case "not_applicable": return { tone: "none", label: "No AI proof (no NEAR AI call)", sentence, action: null };
  }
}

/** Paid jobs by their settlement tx hash (network:hash, the key the ledger and reconcile rows use). */
export function jobsByTx(jobs: Record<string, JobView>): Map<string, JobView> {
  const out = new Map<string, JobView>();
  for (const j of Object.values(jobs)) if (j.txHash) out.set(`${j.network}:${j.txHash}`, j);
  return out;
}

export type AttestAttention = { level: "warn" | "error"; title: string; detail: string; at: number; jobId: string };
/**
 * Live ops "needs attention": jobs whose AI step failed attestation (error), partly verified (warn), or still pending
 * after pendingMs (warn). Newest first, at most max.
 */
export function attestAttention(jobs: Record<string, JobView>, now: number, pendingMs = 10 * 60_000, max = 5): AttestAttention[] {
  const out: AttestAttention[] = [];
  for (const j of Object.values(jobs)) {
    const a = j.attestation, v = attestView(j);
    if (!a || !v) continue;
    const id = `${j.jobId.slice(0, 8)}…`;
    if (a.summary === "unverified") out.push({ level: "error", title: `AI proof failed · job ${id}`, detail: `${v.label}${v.action ? ` · ${v.action}` : ""}`, at: a.receivedMs, jobId: j.jobId });
    else if (a.summary === "partial") out.push({ level: "warn", title: `AI proof partial · job ${id}`, detail: `${v.label}${v.action ? ` · ${v.action}` : ""}`, at: a.receivedMs, jobId: j.jobId });
    else if (a.summary === "unavailable" && now - a.receivedMs > pendingMs) out.push({ level: "warn", title: `AI proof pending · job ${id}`, detail: `evidence not ready after ${Math.round((now - a.receivedMs) / 60_000)} min`, at: a.receivedMs, jobId: j.jobId });
  }
  return out.sort((x, y) => y.at - x.at).slice(0, max);
}

/** USDC base units (6 decimals) as a decimal string, trailing zeros dropped. */
export function usdcOf(base: bigint): string {
  const s = base.toString().padStart(7, "0");
  const frac = s.slice(-6).replace(/0+$/, "");
  return `${s.slice(0, -6)}${frac ? `.${frac}` : ""}`;
}

export type AttestShare = { paidJobs: number; paidBase: bigint; attestedJobs: number; attestedBase: bigint; pendingJobs: number };
/** Paid (or released) jobs on a network and how much of their money paid for a verified NEAR AI job. */
export function attestShare(jobs: Record<string, JobView>, network: string | null): AttestShare {
  const s: AttestShare = { paidJobs: 0, paidBase: 0n, attestedJobs: 0, attestedBase: 0n, pendingJobs: 0 };
  for (const j of Object.values(jobs)) {
    if ((network && j.network !== network) || (j.state !== "paid" && j.state !== "released") || !j.amount || !/^\d+$/.test(j.amount)) continue;
    const base = BigInt(j.amount);
    s.paidJobs++; s.paidBase += base;
    if (j.attestation?.summary === "attested") { s.attestedJobs++; s.attestedBase += base; }
    else if (!j.attestation || j.attestation.summary === "unavailable") s.pendingJobs++;
  }
  return s;
}
