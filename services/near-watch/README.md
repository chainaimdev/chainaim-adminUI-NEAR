# near-watch

near-watch follows NEAR USDC (NEP-141) payments into the paywall's pay-to account. It gets them from up to four independent roads. It also takes the paywall's own claims (`payment_settled`), reconciles the two, and serves everything to the admin console over HTTP and SSE.

| Road | How | Sees |
|---|---|---|
| `neardata` | FastNear neardata, `GET /v0/block/<h>`. The server waits for blocks near the tip | every receipt outcome executed by the USDC contract |
| `qn-rpc` | QuickNode RPC: `block` + `chunk`, then `EXPERIMENTAL_tx_status` (FINAL) for candidates | transactions signed by, or sent to, a watched account, or USDC transfer calls that name one |
| `rpc` | the same, against a public RPC | same as `qn-rpc` |
| `backfill` | from the furthest stored cursor to the start-up tip, run once at start | same as its source |

The first road to deliver a transaction wins. Later roads are stored with their lag behind it, and repeats are dropped. The x402 rule: success, token = `NEAR_USDC_CONTRACT`, receiver = a watched pay-to, and a single `ft_transfer` event. No memo is needed: the x402 NEAR scheme sends none (docs/NEAR-GATES.md A7). Any other transfer is listed but never counted. Claims join transfers by tx hash only; a claim's `invoiceId` is shown, never matched. The RPC roads also find payments relayed as a NEP-366 `Delegate`.

```powershell
npm install
npm test                 # 34 tests: decoder, store, reconcile (incl. late arrival), config (CAIP-2 default), RPC read-ahead, chain-core, end-to-end over the recorded-data doubles
npx tsc -p .             # typecheck
node --env-file=$SECRETS\near-watch.env src/main.ts --watch buyer1=buyer=<buyer>.testnet
node src/main.ts --help  # every flag and its default
```

Endpoints: `/healthz`, `/api/snapshot`, `/api/txs`, `/api/tx/<hash>`, `/api/feeds`, `/api/claims`, `/api/reconcile`, `/api/metrics`, `/api/trace/<invoiceId>`, `/api/seller`, SSE `/stream`, and `POST /ingest/claim|trace`.

**Keeping up.** One RPC height is a `block` call plus about 1.8 `chunk` calls, at 270–370 ms each on testnet. Done one after another, that is 770–970 ms per height, while testnet makes a final block every ~580 ms. So the RPC roads read `--rpc-prefetch` heights at once (default 4; 1 = serial; forced to 1 by `--rpc-min-ms`), and still hand them in strictly in height order. Measured live on 2026-11-04, starting 100 blocks behind: fastnear went from 1.53 to 5.17 heights/s, and QuickNode from 1.00 to 4.90/s, against a chain making ~1.7/s.

**Late arrivals.** A claim marked `only_in_log` (or a transfer marked `only_on_ledger`) turns `matched` when the other side lands. It stays on the same (network, hash) row, its detail starts `late: …`, and a `reconcile_late_match` info alert is raised. `/api/feeds` → `reconcile` shows `--settle-grace-blocks`, its default (30), the grace in seconds at the measured block time, how far the roads trail the chain, and a warning when that trail is at least the grace.

Use the admin key for `/api` and `/stream`. Use the ingest key for `/ingest`.
