/**
 * Quality-candidate hunter. Every `cfg.scan.intervalMin` it screens GMGN trending (thesis + LLM),
 * keeps only survivors that ALSO have a v4 pool in the 3-5% fee band with real volume, and alerts
 * with a 1-tap LP button. This is the focused replacement for the old "every new token" feed spam.
 */
import { cfg, env } from "../config.js";
import { screenTokens, type ScreenResult } from "./screen.js";
import { qualifyCandidate, type QualifiedPool } from "../chain/candidate.js";
import { dexPairs, type DexPair } from "../chain/dexscreener.js";
import { logger } from "../util/log.js";

const log = logger("hunt");

export interface ScanHooks {
  onCandidate: (r: ScreenResult, pool: QualifiedPool, notify: boolean) => void | Promise<void>;
}

export function huntCandidateDecision(now:number,lastAlert:number,cooldownMin:number,autoHuntEnabled:boolean):{evaluate:boolean;notify:boolean} {
  const notify = lastAlert <= 0 || now - lastAlert >= cooldownMin * 60_000;
  return { evaluate: notify || autoHuntEnabled, notify };
}

export async function dispatchCandidateHooks<T>(rows:T[], onCandidate:(row:T)=>void|Promise<void>):Promise<void> {
  for (const row of rows) {
    try { await onCandidate(row); }
    catch (e) { log.warn(`candidate callback failed: ${(e as Error).message.slice(0, 90)}`); }
  }
}

export function singleFlight<T>(fn:()=>Promise<T>):()=>Promise<T> {
  let current:Promise<T>|null=null;
  return () => {
    if (current) return current;
    let task:Promise<T>;
    try { task=fn(); } catch (e) { return Promise.reject(e); }
    current=task;
    const clear=()=>{ if (current===task) current=null; };
    void task.then(clear,clear);
    return task;
  };
}

export function hasViableDexPool(pairs:Map<string,DexPair>, limits:Pick<typeof cfg.scan,'minVolUsd'|'minPoolFeesUsd'|'feeMaxPpm'|'minPoolLiqUsd'>):boolean {
  return [...pairs.values()].some(p => {
    const v4 = p.version.toLowerCase() === 'v4' || (p.version === '' && /^0x[0-9a-f]{64}$/i.test(p.pairAddr));
    return v4 && p.vol24h >= limits.minVolUsd && p.vol24h * limits.feeMaxPpm / 1_000_000 >= limits.minPoolFeesUsd &&
      (p.liqUsd <= 0 || p.liqUsd >= limits.minPoolLiqUsd);
  });
}

export function formatHuntFunnel(x:{trending:number;ranked:number;eligible:number;sampled:number;dexViable:number;qualified:number;unheld:number}):string {
  return `hunt funnel: ${x.trending} trending → ${x.ranked} ranked → ${x.eligible} eligible → ${x.sampled} sampled → ${x.dexViable} DEX-viable → ${x.qualified} qualified → ${x.unheld} unheld`;
}

let timer: ReturnType<typeof setInterval> | null = null;
let hooks: ScanHooks | null = null;
const alerted = new Map<string, number>(); // token → last alert ts (cooldown)
const stats = { scans: 0, alerts: 0, lastAt: 0, lastFound: 0, lastScanned: 0 };

/** Register hooks (pass at boot) and start the timer when enabled. Called again by /hunt on. */
export function startScan(h?: ScanHooks): void {
  if (h) hooks = h;
  if (timer || !hooks || !cfg.scan.enabled) return; // hooks stored, but only run when enabled
  void tick();
  timer = setInterval(() => void tick(), cfg.scan.intervalMin * 60_000);
  log.info(
    `hunt ON — every ${cfg.scan.intervalMin}m · fee ${(cfg.scan.feeMinPpm / 10000).toFixed(0)}-${(cfg.scan.feeMaxPpm / 10000).toFixed(0)}% · vol≥$${cfg.scan.minVolUsd} · score≥${cfg.scan.minScore}`,
  );
}

export function stopScan(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info("hunt OFF");
  }
}

export function isScanOn(): boolean {
  return timer !== null;
}

export function scanStatus(): { on: boolean } & typeof cfg.scan & typeof stats {
  return { on: isScanOn(), ...cfg.scan, ...stats };
}

/** Run one scan immediately (used by /hunt now). */
export async function scanNow(): Promise<{ found: number; scanned: number }> {
  return runScan();
}

async function tick(): Promise<void> {
  try {
    await runScan();
  } catch (e) {
    log.warn(`scan failed: ${(e as Error).message.slice(0, 90)}`);
  }
}

const runScan = singleFlight(performScan);

async function performScan(): Promise<{ found: number; scanned: number }> {
  const s = cfg.scan;
  // Loose GMGN gates (the 3-5% pools live on smaller tokens) + thesis/LLM screening.
  const { results, scanned } = await screenTokens({
    llm: !!env.openrouterKey,
    minMarketCap: s.screenMinMcap,
    minVolume: s.screenMinVol,
    minLiquidity: s.screenMinLiq,
    limit: 40,
  });
  stats.scans++;
  stats.lastAt = Date.now();
  stats.lastScanned = scanned;
  const now = Date.now();
  // survivors past the score/verdict floor and out of cooldown → check the 3-5% pool in parallel
  const eligible = results.filter(
      (r) =>
        r.token.address &&
        r.score >= s.minScore &&
        r.verdict !== "skip" &&
        (s.screenMaxMcap <= 0 || (r.token.marketCap ?? 0) <= s.screenMaxMcap) && // farm SMALL-cap (bigger fee share for small capital)
        huntCandidateDecision(now, alerted.get(r.token.address.toLowerCase()) ?? 0, s.cooldownMin,
          cfg.autoLp.enabled && !cfg.autoLp.entryPaused && cfg.autoLp.sources.includes('hunt')).evaluate,
    );
  const cand = eligible.slice(0, 20);
  const { mapLimit } = await import("../chain/blockscout.js");
  let dexViable = 0;
  const qualified = await mapLimit(cand, 5, async (r) => {
    const market = await dexPairs(r.token.address, Date.now());
    if (!hasViableDexPool(market, s)) return null;
    dexViable++;
    const pool = await qualifyCandidate(r.token.address).catch(() => null);
    return pool ? { r, pool } : null;
  });
  // Tokens we ALREADY hold a position in — don't re-alert / risk a duplicate add (the operator asked:
  // "kalau udah ada posisi di token-nya, skip"). maybeAutoLp already dedupes the auto-add, but this also
  // silences the noisy repeat ALERT (and the manual "LP <token>" tap that would open a 2nd position).
  const held = new Set<string>();
  try {
    const [{ listPositions }, { listV4Positions }] = await Promise.all([import("../chain/positions.js"), import("../chain/v4/list.js")]);
    const [v3, v4] = await Promise.all([listPositions().catch(() => []), listV4Positions().catch(() => [])]);
    for (const r of v3) {
      const a = (r as { tokenAddr?: string }).tokenAddr;
      if (a) held.add(a.toLowerCase());
    }
    for (const r of v4) held.add(r.tokenAddr.toLowerCase());
  } catch {
    /* best-effort — if holdings can't be read, don't block alerts */
  }
  let found = 0;
  await dispatchCandidateHooks(qualified, async q => {
    if (!q) return;
    if (held.has(q.r.token.address.toLowerCase())) {
      log.info(`skip candidate ${q.r.token.symbol} — a position already exists for that token`);
      return;
    }
    const decision = huntCandidateDecision(now, alerted.get(q.r.token.address.toLowerCase()) ?? 0, s.cooldownMin,
      cfg.autoLp.enabled && !cfg.autoLp.entryPaused && cfg.autoLp.sources.includes('hunt'));
    if (decision.notify) alerted.set(q.r.token.address.toLowerCase(), now);
    found++;
    if (decision.notify) stats.alerts++;
    const mc = q.r.token.marketCap ?? 0;
    if (decision.notify) log.info(
      `candidate ${q.r.token.symbol} · mcap $${(mc / 1e3).toFixed(0)}k · pool ${(q.pool.fee / 10000).toFixed(2)}% vol $${(q.pool.volUsd / 1e3).toFixed(1)}k fees $${q.pool.feesUsd.toFixed(0)} · spike ${q.pool.spikeX.toFixed(1)}x · score ${q.r.score}`,
    );
    await hooks?.onCandidate(q.r, q.pool, decision.notify);
  });
  stats.lastFound = found;
  log.info(formatHuntFunnel({trending:scanned,ranked:results.length,eligible:eligible.length,sampled:cand.length,dexViable,qualified:qualified.filter(Boolean).length,unheld:found}));
  return { found, scanned };
}
