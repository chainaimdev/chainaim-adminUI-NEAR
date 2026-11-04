/**
 * Traces: buyer-side steps of one paid call, reported by the rig to POST /ingest/trace, keyed by the call's
 * invoice id (the paywall's; an x402 NEAR transfer carries no memo, so a trace reaches the chain via its claim or tx hash). Same steps as ledger-watch src/traces.ts:
 *   1 quoted  2 signed  3 sent  (4 settled: from the paywall's claim)  5 answered
 * A trace carries names, numbers, an account id and a hash: never a request or answer text.
 */
import { IngestError, isObj, isoMs, optionalAccount, optionalInvoice, txHash, watchedNetwork, type CaipMap } from "./claims.ts";

export const TRACE_STEPS: Readonly<Record<number, string>> = { 1: "quoted", 2: "signed", 3: "sent", 5: "answered" };
export const FIRST_STEP = 1;
export const LAST_STEP = 5;

export type TraceInput = { invoiceId: string; step: number; network: string; tenant: string | null; payer: string | null; tsMs: number; ms: number | null; status: number | null; txHash: string | null };

function optionalInt(v: unknown, field: string, min: number, max: number): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new IngestError(`${field} must be a whole number from ${min} to ${max}`);
  return v;
}

export function parseTrace(input: unknown, caips: CaipMap): TraceInput {
  if (!isObj(input)) throw new IngestError("a trace must be a JSON object");
  if (input.v !== 1) throw new IngestError("v must be 1");
  const invoiceId = optionalInvoice(input.invoiceId);
  if (invoiceId === null) throw new IngestError("invoiceId is required");
  const step = input.step;
  if (typeof step !== "number" || !Object.hasOwn(TRACE_STEPS, step)) throw new IngestError(`step must be one of ${Object.keys(TRACE_STEPS).join(", ")}`);
  if (input.name !== undefined && input.name !== TRACE_STEPS[step]) throw new IngestError(`step ${step} is named "${TRACE_STEPS[step]}"`);
  const tenant = input.tenant;
  if (tenant !== undefined && tenant !== null && (typeof tenant !== "string" || !/^[A-Za-z0-9_.-]{1,40}$/.test(tenant))) throw new IngestError("tenant must be 1-40 letters, digits or . _ -");
  return {
    invoiceId,
    step,
    network: watchedNetwork(input.network, caips),
    tenant: typeof tenant === "string" ? tenant : null,
    payer: optionalAccount(input.payer, "payer"),
    tsMs: isoMs(input.ts, "ts"),
    ms: optionalInt(input.ms, "ms", 0, 86_400_000),
    status: optionalInt(input.status, "status", 100, 599),
    txHash: input.transaction === undefined || input.transaction === null ? null : txHash(input.transaction, "transaction"),
  };
}
