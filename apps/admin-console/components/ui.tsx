/** Small shared pieces: explorer links (near-watch sends them ready-made), road chips, measured/reported tags. */
import { ROAD_CLASS, ROAD_LABELS, short } from "../lib/format.ts";
import type { TxItem } from "../lib/live-store.ts";
import type { Road } from "../lib/types.ts";

/** A link to the block explorer, only when near-watch sent the URL; the browser never builds one. */
export function Ext({ href, children, title }: { href: string | null | undefined; children: React.ReactNode; title?: string }) {
  if (!href) return <span title={title}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title ?? "open in the block explorer"}>
      {children}
    </a>
  );
}

/** The transaction hash (base58, shown as sent), linked to the explorer of its network. */
export function TxLink({ t }: { t: TxItem }) {
  return (
    <Ext href={t.links?.tx} title={`${t.network} · ${t.hash}`}>
      {short(t.hash, 6, 4)}
      {t.links?.tx ? " ↗" : ""}
    </Ext>
  );
}

/** Road chip: neardata green (push-like), qn-rpc orange, rpc amber, backfill muted. */
export function Via({ road }: { road: Road }) {
  return (
    <b className={ROAD_CLASS[road] ?? "backfill"} title={ROAD_LABELS[road] ?? road}>
      {road}
    </b>
  );
}

/** The road that won (first arrival) and a dot per later road, its delay behind the winner on hover. */
export function Roads({ t }: { t: TxItem }) {
  return (
    <span className="via" title={`first via ${t.firstVia}${t.roads.map((r) => ` · ${r.via} +${r.lagMs} ms`).join("")}`}>
      <Via road={t.firstVia} />
      {t.roads.map((r) => (
        <i key={r.via} title={`also via ${r.via}, ${r.lagMs} ms behind the first road`} />
      ))}
    </span>
  );
}

export const Measured = () => <i className="tag measured">measured</i>;
export const Reported = ({ by }: { by?: string }) => <i className="tag reported">reported{by ? ` · ${by}` : ""}</i>;
