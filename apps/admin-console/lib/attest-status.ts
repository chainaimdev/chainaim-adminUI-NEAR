/**
 * The attestation service (private-ai's ca-attest) as the Feeds tab shows it (owner 2026-11-07): is it up, and when it
 * last checked each NEAR AI model's enclave, with the verdict and reasons. Read on the server by /api/attest from
 * ca-attest's own GET /healthz and GET /reports; the browser never learns its address.
 *
 *   ATTEST_URL   ca-attest's root (default http://127.0.0.1:8770, the port private-ai's up.ps1 publishes); "off" hides it.
 *
 * Only a bounded summary is passed on (model, report time, signer, verdict, reasons, the four checks): never quotes,
 * nonces or certificates.
 */
import { ConfigError, parseNearWatchUrl } from "./config.ts";

export const ATTEST_DEFAULT_URL = "http://127.0.0.1:8770";

/** ca-attest's root URL, or null when ATTEST_URL=off. Plain http only on loopback (config.ts's rule). */
export function attestUrl(env: Record<string, string | undefined> = process.env): URL | null {
  const raw = env.ATTEST_URL?.trim() || ATTEST_DEFAULT_URL;
  if (raw === "off") return null;
  return parseNearWatchUrl(raw, "ATTEST_URL");
}

export type ModelReport = {
  model: string; fetchedAt: string | null; error: string | null;
  attestations: { signingAddress: string; verified: boolean; reasons: string[]; tdx: boolean; gpu: boolean | null; bindsNonce: boolean }[];
};
export type AttestStatus =
  | { configured: false }
  | { configured: true; up: false; error: string }
  | { configured: true; up: true; ready: boolean; gpuCheck: boolean | null; models: ModelReport[] };

const str = (v: unknown, max = 200): string | null => (typeof v === "string" ? v.slice(0, max) : null);

/** ca-attest's /healthz and /reports bodies -> the bounded summary. Anything malformed becomes null / empty, never thrown. */
export function summarizeReports(health: unknown, reports: unknown): Extract<AttestStatus, { up: true }> {
  const h = (health ?? {}) as { ready?: unknown; gpuCheck?: unknown };
  const list = Array.isArray((reports as { models?: unknown })?.models) ? ((reports as { models: unknown[] }).models) : [];
  const models: ModelReport[] = list.slice(0, 50).map((m) => {
    const x = (m ?? {}) as { model?: unknown; latest?: { fetchedAt?: unknown; error?: unknown; attestations?: unknown } | null };
    const atts = Array.isArray(x.latest?.attestations) ? (x.latest!.attestations as unknown[]) : [];
    return {
      model: str(x.model) ?? "?",
      fetchedAt: str(x.latest?.fetchedAt),
      error: str(x.latest?.error),
      attestations: atts.slice(0, 20).map((a) => {
        const y = (a ?? {}) as { signingAddress?: unknown; verified?: unknown; reasons?: unknown; checks?: { tdxVerified?: unknown; embedsNonce?: unknown; gpu?: { checked?: unknown; verdict?: unknown } } };
        const g = y.checks?.gpu;
        return {
          signingAddress: str(y.signingAddress, 100) ?? "?",
          verified: y.verified === true,
          reasons: Array.isArray(y.reasons) ? y.reasons.slice(0, 10).map((r) => str(r) ?? "").filter(Boolean) : [],
          tdx: y.checks?.tdxVerified === true,
          gpu: g && g.checked === true ? g.verdict === true : null,
          bindsNonce: y.checks?.embedsNonce === true,
        };
      }),
    };
  });
  return { configured: true, up: true, ready: h.ready === true, gpuCheck: typeof h.gpuCheck === "boolean" ? h.gpuCheck : null, models };
}

/** Reads ca-attest; any failure is { up: false } with a plain reason (no URL in it). */
export async function readAttestStatus(url: URL | null, timeoutMs: number, fetchFn: typeof fetch = fetch): Promise<AttestStatus> {
  if (!url) return { configured: false };
  try {
    const get = async (p: string) => {
      const r = await fetchFn(new URL(p, url), { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`ca-attest answered HTTP ${r.status} on ${p}`);
      return r.json();
    };
    const [health, reports] = await Promise.all([get("healthz"), get("reports")]);
    return summarizeReports(health, reports);
  } catch (e) {
    const reason = e instanceof ConfigError ? e.message : (e as Error).name === "TimeoutError" ? `ca-attest did not answer within ${timeoutMs} ms` : (e as Error).message.startsWith("ca-attest") ? (e as Error).message : "ca-attest is not reachable (is the private-ai desk started with attestation on?)";
    return { configured: true, up: false, error: reason };
  }
}
