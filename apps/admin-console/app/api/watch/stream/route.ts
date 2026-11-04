/** GET /api/watch/stream -> near-watch GET /stream (Server-Sent Events), admin key added here on the server. */
import { ConfigError, loadConfig } from "../../../../lib/config.ts";
import { proxyStream } from "../../../../lib/proxy.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) return Response.json({ error: e.message }, { status: 500, headers: { "cache-control": "no-store" } });
    throw e;
  }
  return proxyStream(req, cfg);
}
