/**
 * Quality-candidate hunter. Every `cfg.scan.intervalMin` it screens GMGN trending (thesis + LLM),
 * keeps only survivors that ALSO have a v4 pool in the 3-5% fee band with real volume, and alerts
 * with a 1-tap LP button. This is the focused replacement for the old "every new token" feed spam.
 */
import { cfg } from "../config.js";
import { screenTokens, type ScreenResult } from "./screen.js";
import { qualifyCandidate, type QualifiedPool } from "../chain/candidate.js";
import { dexPairs, type DexPair } from "../chain/dexscreener.js";
import { rankExactPoolCandidates, fastPoolScore } from "./fast-hunt.js";
import { logger } from "../util/log.js";

const log = logger("hunt");

export interface ScanHooks {
  onCandidate: (r: ScreenResult, pool: QualifiedPool, notify: boolean) => void | Promise<void>;
  onWarning?: (message:string)=>void|Promise<void>;
}

export function huntCandidateDecision(now:number,lastAlert:number,cooldownMin:number,autoHuntEnabled:boolean):{evaluate:boolean;notify:boolean} {
  const notify = lastAlert <= 0 || now - lastAlert >= cooldownMin * 60_000;
  return { evaluate: notify || autoHuntEnabled, notify };
}

export function huntEvaluationDue(now:number,last:{at:number;vol5m:number}|undefined,currentVol5m:number,minVol5m:number):boolean {
  if(!last)return true;
  return now-last.at>=15*60_000 || (currentVol5m>=minVol5m && currentVol5m>=last.vol5m*2);
}

export function scanWarningDue(now:number,last:number):boolean {
  return last<=0 || now-last>=15*60_000;
}

export function selectQualificationBatch<T extends {address:string;vol5m:number}>(rows:T[],checked:Map<string,{at:number;vol5m:number}>,now:number,minVol5m:number,max=12):T[] {
  return rows.filter(r=>huntEvaluationDue(now,checked.get(r.address.toLowerCase()),r.vol5m,minVol5m)).slice(0,max);
}

export function systemicQualificationFailure(attempted:number,errors:number):boolean {
  return attempted>0 && (errors===attempted || (errors>=3 && errors*2>=attempted));
}

export function selectHuntEvaluations<T extends {address:string;vol5m:number}>(rows:T[],last:Map<string,{at:number;vol5m:number}>,held:Set<string>,now:number,minVol5m:number,auto:boolean):T[] {
  return rows.filter(r=>!held.has(r.address.toLowerCase())&&(!auto||huntEvaluationDue(now,last.get(r.address.toLowerCase()),r.vol5m,minVol5m))).slice(0,auto?2:20);
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
const evaluated = new Map<string,{at:number;vol5m:number}>(); // avoid repeated GMGN preflights on unchanged rejects
const qualificationChecked = new Map<string,{at:number;vol5m:number}>(); // bounded rotating RPC batch
let lastWarningAt=0;
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
    const message=`Hunt scan failed: ${(e as Error).message.slice(0, 120)}`;
    log.warn(message);
    const now=Date.now();
    if(scanWarningDue(now,lastWarningAt)) {
      try {
        await hooks?.onWarning?.(message);
        lastWarningAt=now;
      } catch (warningError) { log.warn(`scan warning delivery failed: ${(warningError as Error).message.slice(0,90)}`); }
    }
  }
}

const runScan = singleFlight(performScan);

async function performScan(): Promise<{ found: number; scanned: number }> {
  const s = cfg.scan;
  // Loose GMGN gates (the 3-5% pools live on smaller tokens) + thesis/LLM screening.
  const { results, scanned } = await screenTokens({
    llm: false,
    interval: '5m',
    rankBy: 'volume',
    minMarketCap: s.screenMinMcap,
    minVolume: 0,
    minLiquidity: s.screenMinLiq,
    limit: 100,
  });
  if(scanned===0) throw new Error('GMGN trend feed returned zero tokens');
  stats.scans++;
  stats.lastAt = Date.now();
  stats.lastScanned = scanned;
  const now = Date.now();
  // survivors past the score/verdict floor and out of cooldown → check the 3-5% pool in parallel
  const eligible = results.filter(
      (r) =>
        r.token.address &&
        r.verdict !== "skip" &&
        (s.screenMaxMcap <= 0 || (r.token.marketCap ?? 0) <= s.screenMaxMcap) && // farm SMALL-cap (bigger fee share for small capital)
        huntCandidateDecision(now, alerted.get(r.token.address.toLowerCase()) ?? 0, s.cooldownMin,
          cfg.autoLp.enabled && !cfg.autoLp.entryPaused && cfg.autoLp.sources.includes('hunt')).evaluate,
    );
  const { mapLimit } = await import("../chain/blockscout.js");
  const activity = {
    ...s,
    minVol5m: cfg.autoLp.huntMinVol5m ?? cfg.watch.minVol5m,
    minVol1h: cfg.autoLp.huntMinVol1h ?? cfg.watch.minVol1h,
  };
  let marketErrors=0;
  const markets = await mapLimit(eligible.slice(0, 100), 5, async r => ({
    address: r.token.address.toLowerCase(),
    pairs: await dexPairs(r.token.address, Date.now(),{strict:true}).catch(e=>{
      marketErrors++;
      log.warn(`market ${r.token.symbol}: ${(e as Error).message.slice(0,90)}`);
      return new Map<string,DexPair>();
    }),
  }));
  if(systemicQualificationFailure(markets.length,marketErrors))throw new Error(`DexScreener lookup failed for ${marketErrors}/${markets.length} tokens`);
  const ranked = rankExactPoolCandidates(eligible, new Map(markets.map(m => [m.address, m.pairs])), activity, Date.now());
  const cand = selectQualificationBatch(ranked.map(x=>({address:x.result.token.address,vol5m:x.vol5m??0,x})),qualificationChecked,now,activity.minVol5m,12);
  let qualificationErrors=0;
  const qualificationRejects:Record<string,number>={};
  const qualified = await mapLimit(cand, 3, async ({address,vol5m,x}) => {
    qualificationChecked.set(address.toLowerCase(),{at:now,vol5m});
    const {result:r}=x;
    const pool = await qualifyCandidate(r.token.address, reasons=>{
      for(const [reason,count] of Object.entries(reasons))qualificationRejects[reason]=(qualificationRejects[reason]??0)+count;
    }, 'usd', {...activity,now:Date.now()}).catch(e => {
      qualificationErrors++;
      log.warn(`qualify ${r.token.symbol}: ${(e as Error).message.slice(0,90)}`);
      return null;
    });
    if (!pool) return null;
    const score = fastPoolScore(pool, activity, Date.now());
    return score == null ? null : { r: {...r, score, verdict:'ape' as const}, pool };
  });
  if(Object.keys(qualificationRejects).length)log.info(`qualification rejects: ${Object.entries(qualificationRejects).map(([reason,count])=>`${reason}=${count}`).join(', ')}`);
  if(systemicQualificationFailure(cand.length,qualificationErrors))throw new Error(`on-chain qualification failed for ${qualificationErrors}/${cand.length} sampled tokens`);
  const chosen = qualified.filter((q):q is NonNullable<typeof q>=>q!==null)
    .sort((a,b)=>(b.pool.vol5m??0)-(a.pool.vol5m??0));
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
  const auto=cfg.autoLp.enabled&&!cfg.autoLp.entryPaused&&cfg.autoLp.sources.includes('hunt');
  const selected=selectHuntEvaluations(chosen.map(q=>({address:q.r.token.address,vol5m:q.pool.vol5m??0,q})),evaluated,held,now,activity.minVol5m,auto);
  let found = 0;
  await dispatchCandidateHooks(selected, async ({q,address,vol5m}) => {
    if(auto)evaluated.set(address.toLowerCase(),{at:now,vol5m});
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
  log.info(formatHuntFunnel({trending:scanned,ranked:results.length,eligible:eligible.length,sampled:cand.length,dexViable:ranked.length,qualified:qualified.filter(Boolean).length,unheld:found}));
  return { found, scanned };
}
