/**
 * The accounts near-watch follows, per network:
 *   the paywall's pay-to   env NEAR_PAY_TO_<NETWORK> (label "paywall", role payto, source "paywall")
 *   --watch label=role=account   any number; role is payto | buyer | relayer | other (source "flag"); relayer = the x402
 *                                facilitator's NEAR gas payer (low_gas alert, architecture-adminui-jobs.md ARCH-209)
 * Account ids are checked with the NEAR account-id rules; a duplicate keeps the first entry.
 */
import { isAccountId } from "../../../packages/chain-core/src/near.ts";

export const ROLES = ["payto", "buyer", "other", "relayer"] as const;
export type Role = (typeof ROLES)[number];
export type WatchEntry = { network: string; label: string; role: Role; address: string; source: "paywall" | "flag" };

export class WatchError extends Error {}

export function parseWatch(spec: string, network: string): WatchEntry {
  const parts = spec.split("=");
  if (parts.length !== 3) throw new WatchError(`--watch ${spec}: expected label=role=account`);
  const [label, role, address] = parts;
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(label)) throw new WatchError(`--watch ${spec}: label must be 1-40 letters, digits or . _ -`);
  if (!(ROLES as readonly string[]).includes(role)) throw new WatchError(`--watch ${spec}: role must be one of ${ROLES.join(", ")}`);
  if (!isAccountId(address)) throw new WatchError(`--watch ${spec}: ${address} is not a NEAR account id`);
  return { network, label, role: role as Role, address, source: "flag" };
}

export function buildWatchlist(network: string, payTo: string | null, specs: readonly string[]): { entries: WatchEntry[]; warnings: string[] } {
  const entries: WatchEntry[] = [];
  const warnings: string[] = [];
  const add = (e: WatchEntry): void => {
    if (entries.some((x) => x.network === e.network && x.address === e.address)) warnings.push(`${e.address} is listed twice; keeping ${entries.find((x) => x.address === e.address)?.label}`);
    else entries.push(e);
  };
  if (payTo) {
    if (!isAccountId(payTo)) throw new WatchError(`NEAR_PAY_TO_${network.toUpperCase()}=${payTo} is not a NEAR account id`);
    add({ network, label: "paywall", role: "payto", address: payTo, source: "paywall" });
  }
  for (const s of specs) add(parseWatch(s, network));
  return { entries, warnings };
}
