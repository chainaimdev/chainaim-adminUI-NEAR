/**
 * neardata protocol double (test/ only). Serves the blocks recorded from real testnet neardata by
 * scripts/record-fixture.ts, with the server's documented behaviour (github.com/fastnear/neardata-server):
 *   GET /v0/last_block/final  302 to /v0/block/<tip>
 *   GET /v0/block/<h>         the recorded block; `null` for a height at or below the tip that was not recorded;
 *                             above the tip it waits (long-poll) up to `holdMs`, then answers null
 * `down` makes every request answer 500; `apiKeys` records the ?apiKey= values seen.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Fixture } from "./fixtures.ts";

export class NeardataDouble {
  readonly server: Server;
  readonly paths: string[] = [];
  readonly apiKeys: string[] = [];
  down = false;
  tip: number;
  holdMs = 200;
  url = "";
  private readonly fx: Fixture;

  constructor(fx: Fixture) {
    this.fx = fx;
    this.tip = Math.max(...Object.keys(fx.neardata).map(Number));
    this.server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      this.paths.push(u.pathname);
      const key = u.searchParams.get("apiKey");
      if (key) this.apiKeys.push(key);
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (this.down) return json(500, { error: "down" });
      if (u.pathname === "/v0/last_block/final") {
        res.writeHead(302, { location: `/v0/block/${this.tip}${u.search}` });
        return res.end();
      }
      const m = /^\/v0\/block\/(\d+)$/.exec(u.pathname);
      if (!m) return json(404, { error: "not found" });
      const h = Number(m[1]);
      if (h > this.tip) {
        const t = setTimeout(() => json(200, h <= this.tip ? (this.fx.neardata[String(h)] ?? null) : null), this.holdMs);
        req.on("close", () => clearTimeout(t));
        return;
      }
      return json(200, this.fx.neardata[String(h)] ?? null);
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
