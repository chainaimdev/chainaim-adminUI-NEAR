/**
 * Road `qn-rpc`: the RPC poll road against QuickNode NEAR (HTTPS; testnet + mainnet, archival; quicknode.com/docs/near).
 * The URL carries the QuickNode token: it comes only from env (--quicknode-http-env, default
 * QUICKNODE_NEAR_HTTP_TESTNET) and is shown redacted (scheme + host) everywhere.
 */
import type { Bus } from "../events.ts";
import type { Roads } from "../roads.ts";
import { httpRpc } from "../rpc.ts";
import type { Store } from "../store.ts";
import { RpcPollRoad, type RpcRoadOptions } from "./rpc-poll.ts";

export function quicknodeRoad(opts: RpcRoadOptions, url: string, timeoutMs: number, roads: Roads, store: Store, bus: Bus, fetchImpl?: typeof fetch): RpcPollRoad {
  return new RpcPollRoad(opts, httpRpc("quicknode", url, { timeoutMs, fetchImpl }), roads, store, bus);
}
