/**
 * Dedicated cash-basis v4 pilot management. Runs only while auto is enabled.
 * Entries-only pause leaves exits running; persisted intents guard unknown sends.
 * Quote/close/cash reads share one wallet lock. No legacy HODL-relative fallback.
 */
import { cfg } from "../config.js";
import { acquireWallet, releaseWallet, walletBusy } from "../chain/txlock.js";
import { logger } from "../util/log.js";
import { riskStore } from "./auto-risk.js";
import { runRiskCycle } from "./risk-manager.js";

const log = logger("automanage");

export type CloseReason = "TP" | "SL" | "OOR" | "VFADE" | "FVLOW" | "TRAIL" | "SESSION" | "TIME_TP" | "MAX_HOLD";

export interface AutoCloseInfo {
  tokenId: string;
  sym: string;
  version: "v3" | "v4";
  reason: CloseReason;
  pnlPct: number | null;
  pnlEth: number | null;
  realizedPnlUsd?: number;
  estimatedPnlPct?: number | null;
}
export interface RebalanceInfo {
  oldTokenId: string;
  newTokenId: string | null;
  sym: string;
}
export interface CompoundInfo {
  tokenId: string;
  sym: string;
  feeUsd: number;
}
export interface ManageHooks {
  onAutoClose: (info: AutoCloseInfo) => void;
  onRiskWarning?: (message:string) => void;
  onRebalance?: (info: RebalanceInfo) => void; // #1 OOR → recentered re-open
  onCompound?: (info: CompoundInfo) => void; // #3 fees folded back into a position
}

let timer: ReturnType<typeof setInterval> | null = null;
let hooks: ManageHooks | null = null;
const warningTimes=new Map<string,number>();
function riskWarning(message:string):void {
  log.warn(message);
  if(Date.now()-(warningTimes.get(message)??0)>300_000){warningTimes.set(message,Date.now());hooks?.onRiskWarning?.(message);}
}
const stats = { runs: 0, closed: 0, rebalanced: 0, compounded: 0, nudges: 0, lastAt: 0 };
let tickRunning = false; // a manage tick is in-flight (timer + feed nudge must not overlap)
let lastTickAt = 0; // ts of the last tick START (debounce feed nudges)
// A busy-pool position gets HAMMERED with swaps (SESTRI/GME $60k vol) → the feed nudged the manage
// loop every ~4s, running listV4Positions non-stop → RPC + Blockscout got rate-limited and /list hung.
// 30s still reacts ~3× faster than the 90s poll but stops the hammering. Tune via RH_NUDGE_MS.
const NUDGE_MIN_MS = Number(process.env.RH_NUDGE_MS) || 30_000;

/** Any manage action armed? (loop is a no-op otherwise, even when /auto is ON.) */
function armed(): boolean {
  const a = cfg.autoLp;
  try { if(riskStore.hasSession()) return true; } catch { return true; }
  return a.tpPct > 0 || a.slPct > 0 || a.closeOor || a.compound || a.volFadeX > 0 || a.minFeePerHourUsd > 0;
}

export function startManage(h?: ManageHooks): void {
  if (h) hooks = h;
  if (timer || !hooks) return;
  void tick();
  timer = setInterval(() => void tick(), (cfg.autoLp.manageSec || 90) * 1000);
  log.info(`manage ON — every ${cfg.autoLp.manageSec}s`);
}
export function stopManage(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
export function isManageOn(): boolean {
  return timer !== null;
}
export function manageStatus(): { on: boolean } & typeof stats {
  return { on: isManageOn(), ...stats };
}

async function tick(): Promise<void> {
  if (!cfg.autoLp.enabled || !armed() || tickRunning || walletBusy()) return;
  tickRunning = true;
  lastTickAt = Date.now();
  try {
    // Pilot exits must never fall back to the legacy HODL-relative calculation.
    if(!riskStore.hasSession()) { log.warn('No risk session: automatic exits disabled'); return; }
    const {quoteV4Exit}=await import('../chain/v4/exit-quote.js');
    const {closeV4PositionStrict}=await import('../chain/v4/close.js');
    const {strictCashSnapshot,freshEntryPrice}=await import('./entry-guard.js');
    stats.runs++;stats.lastAt=Date.now();
    await runRiskCycle(riskStore,cfg.autoLp,{
      isEnabled:()=>cfg.autoLp.enabled,
      quote:quoteV4Exit,acquire:acquireWallet,release:releaseWallet,
      settle:async(id,reason)=>{
        const price=await freshEntryPrice();
        const before=await strictCashSnapshot();
        const quoteObservedAt=riskStore.openPositions().find(p=>p.tokenId===id)?.markAt??0;
        const result=await closeV4PositionStrict(id,reason,{quoteObservedAt,beforeBurn:()=>{if(!cfg.autoLp.enabled)throw new Error('Auto stopped before burn');}});
        const after=await strictCashSnapshot(result.confirmedBlockNumber);
        if(after.blockNumber<before.blockNumber)throw new Error('Regressing settlement snapshot');
        if(after.usdg!==before.usdg)throw new Error('Unsettled USDG balance changed; cash PnL unknown');
        return ((after.eth+after.weth)-(before.eth+before.weth))*price.usd;
      },
      notify:i=>{stats.closed++;hooks?.onAutoClose({tokenId:i.tokenId,sym:i.token,version:'v4',reason:i.reason,pnlPct:i.realizedPnlPct,pnlEth:null,realizedPnlUsd:i.realizedPnlUsd,estimatedPnlPct:i.estimatedPnlPct});},
      warn:riskWarning,
    });
  } catch (e) {
    riskWarning(`Risk monitoring unavailable; inspect /auto status. ${(e as Error).message.slice(0, 90)}`);
  } finally {
    tickRunning = false;
  }
}

/**
 * External trigger to run the cash-risk check instead of waiting for the next `manageSec` poll —
 * called by the sequencer feed when a swap touches one of our position tokens (sub-second reaction vs
 * up to 90s). Debounced (≤ once / NUDGE_MIN_MS) and skips if a tick is already running, so a burst of
 * feed events can't hammer the RPC. The interval timer stays as the reliable backstop for anything the
 * feed's partial decode misses. No-op unless /auto is ON and a trigger is armed.
 */
export function nudge(reason = "feed"): void {
  if (!cfg.autoLp.enabled || !armed() || tickRunning) return;
  if (Date.now() - lastTickAt < NUDGE_MIN_MS) return;
  stats.nudges++;
  log.info(`manage nudge (${reason}) → check cash TP/SL/trailing`);
  void tick();
}

