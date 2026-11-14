/**
 * Private-AI agent calls: one record per call answered (or refused) by chainiam-private-ai's quote-agents
 * (privateAI-design-44: tenants jupiter-knitting / tommy-hilfiger-europe; endpoints agents/inventory, agents/logistics,
 * agents/treasury, seller/synthesize, buyer/synthesize). quote-agents sends them to POST /ingest/agent with the ingest
 * key; they are listed by GET /api/agent-calls (admin key), which the admin console reads through its proxy.
 *
 *   agent_call {v:1, event:"agent_call", ts, tenant|null, alias|null, path, status, ms, source|null, requestId|null, code|null}
 *
 * Fail closed, like jobs.ts: every field typed and bounded, unknown fields refused, so only ids, a path, a status, a
 * duration and a source are ever stored — never a request or an answer (no SKU, price, budget, cost or message).
 * A record with a requestId is stored once per (requestId, path); a repeat is accepted and not stored again.
 */
import { IngestError, isObj, isoMs } from "./claims.ts";

export const AGENT_CALL_FIELDS = ["v", "event", "ts", "tenant", "alias", "path", "status", "ms", "source", "requestId", "code"] as const;
const TENANT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ALIAS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** An endpoint path relative to the tenant (agents/inventory) or, for a refused call, the request path (/v1/...). */
const PATH = /^\/?[a-z0-9][a-z0-9\/._-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const CODE = /^[a-z][a-z0-9_]{0,47}$/;
export const AGENT_SOURCES = ["rules", "ai"] as const;

export type AgentCallInput = {
  tsMs: number; tenant: string | null; alias: string | null; path: string; status: number; ms: number;
  source: (typeof AGENT_SOURCES)[number] | null; requestId: string | null; code: string | null;
};
export type AgentCallRow = AgentCallInput & { id: number; receivedMs: number };

const optional = (v: unknown, field: string, re: RegExp): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !re.test(v)) throw new IngestError(`${field} is not valid`);
  return v;
};
const int = (v: unknown, field: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new IngestError(`${field} must be a whole number from ${min} to ${max}`);
  return v;
};

export function parseAgentCall(input: unknown): AgentCallInput {
  if (!isObj(input)) throw new IngestError("an agent call must be a JSON object");
  for (const k of Object.keys(input)) if (!(AGENT_CALL_FIELDS as readonly string[]).includes(k)) throw new IngestError(`unknown field ${k}`);
  if (input.v !== 1) throw new IngestError("v must be 1");
  if (input.event !== "agent_call") throw new IngestError('event must be "agent_call"');
  if (typeof input.path !== "string" || !PATH.test(input.path)) throw new IngestError("path is not valid");
  const source = input.source;
  if (source !== undefined && source !== null && !(AGENT_SOURCES as readonly unknown[]).includes(source)) throw new IngestError(`source must be one of ${AGENT_SOURCES.join(", ")}`);
  return {
    tsMs: isoMs(input.ts, "ts"),
    tenant: optional(input.tenant, "tenant", TENANT),
    alias: optional(input.alias, "alias", ALIAS),
    path: input.path,
    status: int(input.status, "status", 100, 599),
    ms: int(input.ms, "ms", 0, 600_000),
    source: (source ?? null) as AgentCallInput["source"],
    requestId: optional(input.requestId, "requestId", REQUEST_ID),
    code: optional(input.code, "code", CODE),
  };
}

/** Counts for the console header: calls per tenant and how many were not 2xx. */
export function agentCallSummary(rows: AgentCallRow[]): { total: number; failed: number; byTenant: Record<string, number> } {
  const byTenant: Record<string, number> = {};
  for (const r of rows) byTenant[r.tenant ?? "unknown"] = (byTenant[r.tenant ?? "unknown"] ?? 0) + 1;
  return { total: rows.length, failed: rows.filter((r) => r.status < 200 || r.status > 299).length, byTenant };
}
