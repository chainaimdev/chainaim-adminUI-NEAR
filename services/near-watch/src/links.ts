/**
 * Explorer links, built on the server so the browser never assembles URLs (ported from ledger-watch src/links.ts).
 * GATE A6 (docs/NEAR-GATES.md): NearBlocks routes /txns/<hash> and /address/<account> (from the NearBlocks
 * frontend source; the site refuses automated fetches). Configured with --explorer <network>=<base>|none,
 * --explorer-tx-path, --explorer-account-path.
 */
import { isAccountId, isNearHash } from "../../../packages/chain-core/src/near.ts";
import type { Row } from "./decode.ts";

export type ExplorerConfig = { bases: Partial<Record<string, string>>; txPath: string; accountPath: string };
export type RowLinks = { tx: string | null; account: string | null; destination: string | null };

export class Links {
  private readonly cfg: ExplorerConfig;
  constructor(cfg: ExplorerConfig) {
    this.cfg = cfg;
  }

  private join(network: string, path: string): string | null {
    const base = this.cfg.bases[network];
    return base ? `${base.replace(/\/+$/, "")}${path}` : null;
  }

  tx(network: string, hash: string): string | null {
    return isNearHash(hash) ? this.join(network, this.cfg.txPath.replace("{hash}", hash)) : null;
  }

  account(network: string, account: string | null | undefined): string | null {
    return account && isAccountId(account) ? this.join(network, this.cfg.accountPath.replace("{address}", encodeURIComponent(account))) : null;
  }

  forRow(row: Pick<Row, "network" | "hash" | "from" | "to">): RowLinks {
    return { tx: this.tx(row.network, row.hash), account: this.account(row.network, row.from), destination: this.account(row.network, row.to) };
  }

  decorate<T extends { row: Row }>(entry: T): T & { network: string; links: RowLinks } {
    return { ...entry, network: entry.row.network, links: this.forRow(entry.row) };
  }
}
