/** GET /api/watch/<path> -> near-watch GET /api/<path>, admin key added here on the server (lib/proxy.ts). */
import { ConfigError, loadConfig } from "../../../../lib/config.ts";
import { proxyGet } from "../../../../lib/proxy.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) return Response.json({ error: e.message }, { status: 500, headers: { "cache-control": "no-store" } });
    throw e;
  }
  const { path } = await ctx.params;
  return proxyGet(req, path, cfg);
}
