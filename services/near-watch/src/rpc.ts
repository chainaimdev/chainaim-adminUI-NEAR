/**
 * NEAR JSON-RPC over HTTP POST. One JSON-RPC object per request: nearcore rejects batches
 * (docs.near.org/api/rpc/providers; DESIGN §3). URLs may carry a QuickNode token, so they are never logged or
 * returned: errors name the provider only.
 */
import { redactUrl, scrub } from "../../../packages/chain-core/src/redact.ts";

export class RpcError extends Error {
  /** nearcore error cause name, e.g. UNKNOWN_BLOCK, UNKNOWN_TRANSACTION, TIMEOUT_ERROR. */
  readonly cause_name: string | null;
  constructor(message: string, causeName: string | null = null) {
    super(message);
    this.cause_name = causeName;
  }
}

export type Rpc = { name: string; host: string; call<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> };

export function httpRpc(name: string, url: string, opts: { timeoutMs: number; fetchImpl?: typeof fetch }): Rpc {
  const f = opts.fetchImpl ?? fetch;
  let id = 0;
  return {
    name,
    host: redactUrl(url),
    async call<T>(method: string, params: unknown, timeoutMs = opts.timeoutMs): Promise<T> {
      id += 1;
      let res: Response;
      try {
        res = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: `nw-${id}`, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new RpcError(`${name} ${method}: ${scrub((e as Error).message, [url])}`);
      }
      const text = await res.text();
      let body: { result?: T; error?: { name?: string; message?: string; cause?: { name?: string; info?: unknown }; data?: unknown } };
      try {
        body = JSON.parse(text);
      } catch {
        throw new RpcError(`${name} ${method}: HTTP ${res.status}, body is not JSON`);
      }
      if (body.error) {
        const cause = body.error.cause?.name ?? null;
        const data = typeof body.error.data === "string" ? body.error.data : "";
        throw new RpcError(`${name} ${method}: ${cause ?? body.error.name ?? "error"} ${scrub(String(body.error.message ?? data), [url])}`.trim(), cause);
      }
      if (!res.ok) throw new RpcError(`${name} ${method}: HTTP ${res.status}`);
      return body.result as T;
    },
  };
}

/** Try each endpoint in order; the first that answers wins. A semantic error (UNKNOWN_BLOCK ...) is returned at once. */
export class RpcPool {
  readonly endpoints: Rpc[];
  failovers = 0;
  constructor(endpoints: Rpc[]) {
    this.endpoints = endpoints;
  }
  get size(): number {
    return this.endpoints.length;
  }
  async call<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    let last: Error = new RpcError("no RPC endpoint configured");
    for (const [i, e] of this.endpoints.entries()) {
      try {
        return await e.call<T>(method, params, timeoutMs);
      } catch (err) {
        if (err instanceof RpcError && err.cause_name) throw err;
        last = err as Error;
        if (i < this.endpoints.length - 1) this.failovers += 1;
      }
    }
    throw last;
  }
}

/** A view call (`query` / `call_function`) decoded as JSON. Args are JSON, sent base64. */
export async function viewFunction<T>(rpc: Pick<Rpc, "call">, contract: string, method: string, args: unknown): Promise<T> {
  const r = await rpc.call<{ result: number[] }>("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
}
