/** GET /api/attest -> private-ai's ca-attest /healthz + /reports, summarized on the server (lib/attest-status.ts). */
import { ConfigError } from "../../../lib/config.ts";
import { attestUrl, readAttestStatus } from "../../../lib/attest-status.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  let url;
  try {
    url = attestUrl();
  } catch (e) {
    if (e instanceof ConfigError) return Response.json({ configured: true, up: false, error: e.message }, { status: 200, headers: { "cache-control": "no-store" } });
    throw e;
  }
  const timeout = Number(process.env.ATTEST_TIMEOUT_MS ?? "4000");
  return Response.json(await readAttestStatus(url, Number.isInteger(timeout) && timeout >= 100 && timeout <= 60_000 ? timeout : 4000), { headers: { "cache-control": "no-store" } });
}
