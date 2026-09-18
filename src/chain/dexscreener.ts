/**
 * DexScreener enrichment — per-pool 24h VOLUME + liquidity for a token. On Robinhood Chain v4 uses
 * a singleton PoolManager, so neither DexScreener nor an on-chain `getLiquidity()` snapshot reports
 * standing TVL reliably (both read ~$0 for live, high-volume v4 pools). VOLUME, however, IS reported
 * and is the signal that matters for high-fee farming (small capital · high fee · high turnover).
 *
 * Match key (DexScreener `pairAddress`, lowercased):
 *   • v2 / v3 → the pool CONTRACT address
 *   • v4      → the 32-byte POOL ID (verified: pairAddress === keccak poolId)
 */
import { logger } from "../util/log.js";

const log = logger("dexscreener");

export interface DexPair {
  pairAddr: string; // lowercased pool address (v2/v3) or poolId (v4)
  baseTokenAddress:string;
  quoteTokenAddress:string;
  vol24h: number;
  liqUsd: number; // DexScreener's liquidity — accurate for v2/v3, ~0 for v4 on Robinhood
  dexId: string;
  version: string; // "v2" | "v3" | "v4" | ""
  chgH1: number; // % price change 1h (signed) — volatility signal for adaptive range width
  chgH6: number; // % price change 6h (signed)
  volH1: number; // 1h volume ($) — spike/fade signal (recent activity vs 24h average)
  vol5m?:number;
  buys5m?:number;
  sells5m?:number;
  observedAt?:number;
}

const cache = new Map<string, { at: number; map: Map<string, DexPair>; error?:string }>();
const TTL_MS = 30_000;

/** Pairs for a token keyed by lowercased pairAddress. Cached ~30s; strict callers see upstream failures. */
export async function dexPairs(token: string, now: number, opts?:{strict?:boolean}): Promise<Map<string, DexPair>> {
  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) {
    if(opts?.strict && hit.error)throw new Error(hit.error);
    return hit.map;
  }

  const map = new Map<string, DexPair>();
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { signal: AbortSignal.timeout(8000) });
    if(r.ok===false)throw new Error(`DexScreener HTTP ${r.status}`);
    const j: any = await r.json().catch(() => null);
    if(opts?.strict && (!j || !Object.hasOwn(j,'pairs') || (j.pairs!==null && !Array.isArray(j.pairs))))throw new Error('DexScreener pairs unavailable');
    for (const p of j?.pairs ?? []) {
      const pa = String(p.pairAddress ?? "").toLowerCase();
      if(p.chainId!=='robinhood')continue;
      if (!pa) continue;
      map.set(pa, {
        pairAddr: pa,
        baseTokenAddress:String(p.baseToken?.address??'').toLowerCase(),
        quoteTokenAddress:String(p.quoteToken?.address??'').toLowerCase(),
        vol24h: Number(p.volume?.h24 ?? 0),
        liqUsd: Number(p.liquidity?.usd ?? 0),
        dexId: String(p.dexId ?? ""),
        version: (p.labels ?? []).find((l: string) => /^v[234]$/.test(String(l).toLowerCase())) ?? "",
        chgH1: Number(p.priceChange?.h1 ?? 0),
        chgH6: Number(p.priceChange?.h6 ?? 0),
        volH1: Number(p.volume?.h1 ?? 0),
        vol5m:p.volume?.m5==null?undefined:Number(p.volume.m5),
        buys5m:p.txns?.m5?.buys==null?undefined:Number(p.txns.m5.buys),
        sells5m:p.txns?.m5?.sells==null?undefined:Number(p.txns.m5.sells),
        observedAt:now,
      });
    }
  } catch (e) {
    const message=`dexPairs failed: ${(e as Error).message.slice(0, 80)}`;
    log.warn(message);
    cache.set(key,{at:now,map,error:message});
    if(opts?.strict)throw new Error(message);
    return map;
  }
  cache.set(key, { at: now, map });
  return map;
}
