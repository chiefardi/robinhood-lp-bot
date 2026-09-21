/**
 * Candidate qualifier — does a token have a v4 pool in the target fee band (3-5%) with real 24h
 * volume? This is the "hard gate" shared by the hunter scanner and the feed: a token only counts
 * as a farmable LP candidate if there's an actual high-fee pool with turnover to earn from.
 */
import { cfg } from "../config.js";
import { discoverV4Pools, discoverV4UsdgPools, type V4Pool } from "./v4/discover.js";
import { dexPairs, type DexPair } from "./dexscreener.js";
import { poolActivityFailure } from "../radar/entry-guard.js";
import type {ActivityCoverage} from '../radar/fast-hunt.js';

export interface AutoPoolActivity {minVol5m:number;minVol1h:number;now:number}
export function discoveryTargetsForQuote(quoteFilter?:"eth"|"usd"):{eth:boolean;usd:boolean} {
  return {eth:quoteFilter!=='usd',usd:quoteFilter!=='eth'};
}

export interface QualifiedPool {
  activity?:ActivityCoverage;
  v4: V4Pool;
  fee: number;
  quote: "eth" | "usd";
  volUsd: number; // pool 24h volume (DexScreener)
  liqUsd: number;
  feesUsd: number; // est. 24h fees the pool generated = volUsd × feeRate
  feeYieldPct: number; // daily fee yield vs TVL (0 when TVL unreadable)
  volPct: number; // |price change| % (max of 1h/6h) — volatility for adaptive range width
  volH1: number; // 1h volume ($)
  spikeX: number; // volH1 / (vol24h/24) — recent hour vs 24h-avg hour; >1 = heating up NOW (#1 spike)
  vol5m?:number;buys5m?:number;sells5m?:number;observedAt?:number;
}

/**
 * Best v4 pool for `token` inside [feeMinPpm, feeMaxPpm]. Gates (#1 fee-yield):
 *   - volume ≥ minVolUsd (busy)
 *   - 24h fees generated (vol × feeRate) ≥ minPoolFeesUsd — weights a busy HIGH-fee pool over raw
 *     volume (a 5% pool at $8k vol beats a 3% pool at $9k), which is exactly what we farm.
 *   - daily fee/TVL yield ≥ minFeeYieldPct — only when TVL is readable (v4 singleton often reads $0,
 *     so this is skipped rather than blocking).
 * Ranks the survivors by absolute 24h fees (the real earning signal), not raw volume.
 */
export function evaluateCandidatePools(
  pools: V4Pool[], dex: Map<string, DexPair>, s: typeof cfg.scan, quoteFilter?: "eth" | "usd", autoActivity?: AutoPoolActivity,
): { pool: QualifiedPool | null; rejected: Record<string, number> } {
  let best: QualifiedPool | null = null;
  const rejected: Record<string, number> = {};
  const reject = (reason: string): void => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
  if (!pools.length) reject('no-v4-pools-returned');
  for (const p of pools) {
    if (quoteFilter && p.quote !== quoteFilter) { reject('quote-outside-target'); continue; }
    if (autoActivity && p.poolKey.hooks.toLowerCase() !== '0x0000000000000000000000000000000000000000') { reject('hooked-pool'); continue; }
    if (p.fee < s.feeMinPpm || p.fee > s.feeMaxPpm) { reject('fee-outside-band'); continue; }
    const d = dex.get(p.poolId.toLowerCase());
    if (autoActivity && poolActivityFailure(d ?? {}, autoActivity, autoActivity.now)) { reject('recent-activity-below-minimum'); continue; }
    const volUsd = d?.vol24h ?? 0;
    if (volUsd < s.minVolUsd) { reject(d ? '24h-volume-below-minimum' : 'dex-pair-data-missing'); continue; }
    const liqUsd = d?.liqUsd ?? 0;
    // ANTI-WASH: a pool with big volume but near-zero REAL liquidity is a wash/trap (fake volume; your
    // LP would be ~all the liquidity → exposed to the wash operator + rug). Only assessable when liq is
    // READABLE (>0); v4 singleton liq often reads $0 (unknown → not blocked here).
    if (liqUsd > 0 && s.minPoolLiqUsd > 0 && liqUsd < s.minPoolLiqUsd) { reject('pool-liquidity-below-minimum'); continue; }
    if (liqUsd > 0 && s.maxVolLiqRatio > 0 && volUsd / liqUsd > s.maxVolLiqRatio) { reject('volume-liquidity-ratio-too-high'); continue; }
    const feesUsd = volUsd * (p.fee / 1e6); // fee ppm → rate (30000ppm = 3%)
    if (feesUsd < s.minPoolFeesUsd) { reject('24h-fees-below-minimum'); continue; }
    const feeYieldPct = liqUsd > 0 ? (feesUsd / liqUsd) * 100 : 0;
    if (liqUsd > 0 && s.minFeeYieldPct > 0 && feeYieldPct < s.minFeeYieldPct) { reject('fee-yield-below-minimum'); continue; }
    const volPct = Math.max(Math.abs(d?.chgH1 ?? 0), Math.abs(d?.chgH6 ?? 0));
    // #1 volume-SPIKE: recent hour vs the 24h-average hour. >1 = heating up NOW (the Meteora "hunt the
    // spike" idea). A stale pool (all its 24h volume happened hours ago) reads spikeX ~0 → skip when armed.
    const volH1 = d?.volH1 ?? 0;
    const spikeX = volUsd > 0 ? volH1 / (volUsd / 24) : 0;
    if (s.minSpikeX > 0 && spikeX < s.minSpikeX) { reject('hourly-spike-below-minimum'); continue; }
    if (!best || feesUsd > best.feesUsd) best = { v4: p, fee: p.fee, quote: p.quote, volUsd, liqUsd, feesUsd, feeYieldPct, volPct, volH1, spikeX,vol5m:d?.vol5m,buys5m:d?.buys5m,sells5m:d?.sells5m,observedAt:d?.observedAt };
  }
  return { pool: best, rejected };
}

export function formatCandidateRejection(rejected: Record<string, number>): string {
  const parts = Object.entries(rejected)
    .filter(([, count]) => Number.isSafeInteger(count) && count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason}=${count}`);
  return parts.length ? parts.join(', ') : 'unclassified-pool-rejection';
}

export async function qualifyCandidate(token: string, onRejected?: (reasons: Record<string, number>) => void, quoteFilter?: "eth" | "usd", autoActivity?: AutoPoolActivity): Promise<QualifiedPool | null> {
  const target=discoveryTargetsForQuote(quoteFilter);
  const [eth, usd, dex] = await Promise.all([
    target.eth?discoverV4Pools(token).catch(() => [] as V4Pool[]):Promise.resolve([] as V4Pool[]),
    target.usd?(autoActivity?discoverV4UsdgPools(token,true):discoverV4UsdgPools(token).catch(() => [] as V4Pool[])):Promise.resolve([] as V4Pool[]),
    autoActivity?dexPairs(token, Date.now(),{strict:true}):dexPairs(token, Date.now()).catch(() => new Map<string, DexPair>()),
  ]);
  const result = evaluateCandidatePools([...eth, ...usd], dex, cfg.scan, quoteFilter, autoActivity);
  if (!result.pool) onRejected?.(result.rejected);
  return result.pool;
}
