/**
 * NEAR JSON-RPC protocol double (test/ only; pattern: liveops test/rippled-double.ts). It serves ONLY responses
 * recorded from real testnet by scripts/record-fixture.ts — block, chunk, EXPERIMENTAL_tx_status, query — and the
 * same error shape nearcore uses for anything it does not hold (cause UNKNOWN_BLOCK / UNKNOWN_CHUNK /
 * UNKNOWN_TRANSACTION). Batches are refused with HTTP 400, as nearcore does. `down` makes it answer 503.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Fixture } from "./fixtures.ts";

type Block = { header: { height: number; hash: string } };

export class NearRpcDouble {
  readonly server: Server;
  readonly calls: { method: string; params: unknown }[] = [];
  down = false;
  /** Delay before each answer (a provider's round trip), and the most requests seen in flight at once. */
  latencyMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  /** Height `block {finality: final}` reports (default: the highest recorded). */
  tip: number;
  private readonly fx: Fixture & { views?: Record<string, unknown> };
  url = "";

  constructor(fx: Fixture) {
    this.fx = fx;
    this.tip = Math.max(...Object.values(fx.blocks).map((b) => b.header.height));
    this.server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (d: Buffer) => parts.push(d));
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      res.on("close", () => (this.inFlight -= 1));
      req.on("end", () => (this.latencyMs > 0 ? setTimeout(answer, this.latencyMs) : answer()));
      const answer = (): void => {
        const send = (status: number, body: unknown): void => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (this.down) return send(503, { error: "down" });
        let body: { id?: unknown; method?: string; params?: Record<string, unknown> };
        try {
          body = JSON.parse(Buffer.concat(parts).toString("utf8"));
        } catch {
          return send(400, { error: "not json" });
        }
        if (Array.isArray(body)) return send(400, { error: "batch requests are not supported" });
        const { id, method = "", params = {} } = body;
        this.calls.push({ method, params });
        const ok = (result: unknown): void => send(200, { jsonrpc: "2.0", id, result });
        const err = (name: string): void => send(200, { jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR", cause: { name, info: {} }, code: -32000, message: name } });
        const blocks = Object.values(this.fx.blocks) as Block[];
        if (method === "block") {
          if (params.finality === "final") {
            const b = blocks.filter((x) => x.header.height <= this.tip).sort((a, c) => c.header.height - a.header.height)[0];
            return b ? ok(b) : err("UNKNOWN_BLOCK");
          }
          const id2 = params.block_id;
          const b = blocks.find((x) => (typeof id2 === "number" ? x.header.height === id2 : x.header.hash === id2));
          return b && b.header.height <= this.tip ? ok(b) : err("UNKNOWN_BLOCK");
        }
        if (method === "chunk") {
          const c = this.fx.chunks[String(params.chunk_id)];
          return c ? ok(c) : err("UNKNOWN_CHUNK");
        }
        if (method === "EXPERIMENTAL_tx_status") {
          return params.tx_hash === this.fx.txStatus.transaction.hash ? ok(this.fx.txStatus) : err("UNKNOWN_TRANSACTION");
        }
        if (method === "query") {
          const key = params.request_type === "view_account" ? `view_account:${params.account_id}` : `call_function:${params.account_id}:${params.method_name}:${params.args_base64}`;
          const v = this.fx.views?.[key];
          return v ? ok(v) : err(params.request_type === "view_account" ? "UNKNOWN_ACCOUNT" : "NO_CONTRACT_CODE");
        }
        return send(200, { jsonrpc: "2.0", id, error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "METHOD_NOT_FOUND" }, message: method } });
      };
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }
}
