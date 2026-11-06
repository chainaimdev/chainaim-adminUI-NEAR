/**
 * Operator re-judge of one false reconcile mismatch (src/reconcile.ts rejudge, POST /admin/reconcile/rejudge).
 * Run inside the near-watch container, so the admin key comes from near-watch's own env file and never reaches a
 * command line or this script's output:
 *
 *   docker exec ca-near-watch node --env-file=/run/secrets/near-watch.env src/rejudge.ts --hash <tx hash>
 *     --receiver <pay-to account the transfer went to> --reason "<why, e.g. receiver checked on the explorer>"
 *
 *   --hash H              the transaction hash of the mismatched row (base58); this or --all-mismatches
 *   --all-mismatches      every mismatch row near-watch holds (GET /api/reconcile?state=mismatch), each re-judged on its
 *                         own: a row that fails any check (another receiver, a real amount / payer / token disagreement)
 *                         stays a mismatch and is reported. Used by chainiam-private-ai test-console\desk.ps1 -RejudgeReceiver
 *   --receiver ACCOUNT    the account the transfer went to, as checked by the operator; required. It must be a watched
 *                         pay-to now and equal the stored transfer's receiver, or nothing changes
 *   --reason TEXT         1-200 characters on one line, kept in the row's detail; required
 *   --network NAME        (testnet)
 *   --url URL             near-watch (http://127.0.0.1:8790, i.e. itself inside the container)
 *   --admin-key-env NAME  env var holding the admin key (ADMIN_API_KEY, near-watch's own default)
 *   --timeout-ms N        (10000)
 *
 * Prints near-watch's answer per row: the new state and detail, or why nothing changed. Exit 0 = every row re-judged
 * (or no mismatch to re-judge), 1 = at least one refused, 2 = usage.
 */
import { parseArgs } from "node:util";

const USAGE = "usage: node --env-file=/run/secrets/near-watch.env src/rejudge.ts (--hash <tx> | --all-mismatches) --receiver <account> --reason \"<text>\" [--network testnet] [--url http://127.0.0.1:8790] [--admin-key-env ADMIN_API_KEY] [--timeout-ms 10000]";

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

let values: Record<string, string | undefined>;
try {
  values = parseArgs({
    options: {
      hash: { type: "string" },
      "all-mismatches": { type: "boolean", default: false },
      receiver: { type: "string" },
      reason: { type: "string" },
      network: { type: "string", default: "testnet" },
      url: { type: "string", default: "http://127.0.0.1:8790" },
      "admin-key-env": { type: "string", default: "ADMIN_API_KEY" },
      "timeout-ms": { type: "string", default: "10000" },
    },
    strict: true,
    allowPositionals: false,
  }).values as unknown as Record<string, string | undefined>;
} catch (e) {
  fail(2, `${(e as Error).message}\n${USAGE}`);
}
const all = (values["all-mismatches"] as unknown) === true;
if (all === Boolean(values.hash)) fail(2, `give --hash or --all-mismatches (one of them)\n${USAGE}`);
for (const k of ["receiver", "reason"]) if (!values[k]) fail(2, `--${k} is required\n${USAGE}`);
const keyEnv = values["admin-key-env"] as string;
const key = process.env[keyEnv];
if (!key) fail(2, `env ${keyEnv} is not set: run with --env-file=/run/secrets/near-watch.env (the key itself is never printed)`);
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail(2, "--timeout-ms must be a positive integer");
let base: URL;
try {
  base = new URL("/admin/reconcile/rejudge", values.url);
} catch {
  fail(2, `--url ${values.url} is not a URL`);
}

async function call(path: string, init: RequestInit): Promise<{ status: number; text: string }> {
  const res = await fetch(new URL(path, base), { ...init, headers: { ...(init.headers as Record<string, string>), "x-admin-key": key as string }, signal: AbortSignal.timeout(timeoutMs) }).catch((e: unknown) =>
    fail(1, `near-watch did not answer at ${base.origin}: ${(e as Error).message}`),
  );
  return { status: res.status, text: await res.text() };
}

let hashes: { network: string; hash: string }[];
if (all) {
  const list = await call("/api/reconcile?state=mismatch&limit=1000", { method: "GET" });
  if (list.status !== 200) fail(1, `HTTP ${list.status} ${list.text}`);
  const rows = (JSON.parse(list.text) as { rows?: { network: string; hash: string }[] }).rows ?? [];
  hashes = rows.filter((r) => r.network === values.network).map((r) => ({ network: r.network, hash: r.hash }));
  console.log(`${hashes.length} mismatch row(s) on ${values.network}`);
} else {
  hashes = [{ network: values.network as string, hash: values.hash as string }];
}
let refused = 0;
for (const h of hashes) {
  const r = await call("/admin/reconcile/rejudge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ network: h.network, hash: h.hash, receiver: values.receiver, reason: values.reason }) });
  if (r.status !== 200) refused += 1;
  console.log(`${all ? `${h.hash}: ` : ""}HTTP ${r.status} ${r.text}`);
}
process.exit(refused === 0 ? 0 : 1);
