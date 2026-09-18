/** Bounded, fail-closed auto-entry pilot. No v3 or fee-only pool fallback. */
import { cfg } from '../config.js';
import { acquireWallet, releaseWallet } from '../chain/txlock.js';
import { inOorCooldown } from './oorcool.js';
import { logger } from '../util/log.js';
import { gmgnToken } from './gmgn.js';
import { riskStore,validateExitSettings } from './auto-risk.js';
import { guardedEntry, securityFailure, llmFailure, heuristicScreenFailure, poolActivityFailure, activityLimits, formatPoolActivityTelemetry, formatHolderTelemetry, entryBasisUsd, strictCashSnapshot, strictInventory, freshEntryPrice } from './entry-guard.js';
import type { Candidate, Verdict } from './radar.js';

const log = logger('autolp');
const GAS_RESERVE = 0.0004;
type OpenLike = { tokenId:string|null; txHash:string; tickLower:number; tickUpper:number; depositEth?:string; poolId?:string; mode?:string; side?:string; entryMcap?:number; swapHash?:string };
export interface AutoLpResult { opened:boolean; reason:string; token:string; symbol:string; sizeEth?:number; result?:OpenLike }

export async function maybeAutoLp(candidate: Candidate, verdict: Verdict | null): Promise<AutoLpResult | null> {
  if (!cfg.autoLp.enabled) return null;
  const skip = (reason:string):AutoLpResult => {
    log.info(`skip ${candidate.symbol}: ${reason}`);
    return {opened:false,reason,token:candidate.token,symbol:candidate.symbol};
  };
  try {
    let sizeEth = 0;
    let reservationId:string|undefined;
    const result = await guardedEntry({
      acquire: acquireWallet,
      release: releaseWallet,
      allowed: () => {
        validateExitSettings(cfg.autoLp);
        return cfg.autoLp.slPct>0 && (cfg.autoLp.tpPct>0||cfg.autoLp.trailActivationPct>0) && cfg.autoLp.enabled && !cfg.autoLp.entryPaused && riskStore.entryAllowed();
      },
      prepare: async () => {
        const a = cfg.autoLp;
        if (!a.sources.includes(candidate.source)) throw new Error('source not allowed');
        if (inOorCooldown(candidate.token)) throw new Error('OOR cooldown');
        const llmBlock = llmFailure(verdict,a.requireLlm,a.requireAction,a.minScore);
        if (llmBlock) throw new Error(llmBlock);
        if (candidate.source === 'hunt') {
          const screenBlock = heuristicScreenFailure(verdict,a.minScore,a.requireAction);
          if (screenBlock) throw new Error(screenBlock);
        }
        const tracked = riskStore.openPositions();
        if (tracked.length >= Math.min(3, a.maxOpen)) throw new Error('maximum open positions');
        if (tracked.some(r=>r.token.toLowerCase() === candidate.token.toLowerCase())) throw new Error('position already exists for token');
        await strictInventory(tracked.map(r=>r.tokenId));
        const g = await gmgnToken(candidate.token,{holders:true});
        log.info(`preflight ${candidate.symbol}: ${formatHolderTelemetry(g?.holderEvidence)}`);
        const failure = securityFailure(g, a.maxTaxPct, Date.now());
        if (failure) throw new Error(failure);
        const {qualifyCandidate} = await import('../chain/candidate.js');
        const q = await qualifyCandidate(candidate.token);
        if (!q) throw new Error('no qualified v4 pool; v3 fallback prohibited');
        const limits=activityLimits(candidate.source,cfg.watch,a);
        log.info(`preflight ${candidate.symbol}: ${formatPoolActivityTelemetry(q,limits)}`);
        const activity=poolActivityFailure(q,limits,Date.now());
        if(activity)throw new Error(activity);
        if (q.quote !== 'usd') throw new Error('ETH auto route blocked: exact qualified pool execution unavailable');
        if (!Number.isFinite(q.liqUsd) || q.liqUsd <= 0 || q.liqUsd < Math.max(a.minLiqUsd,cfg.scan.minPoolLiqUsd)) throw new Error('qualified pool liquidity missing or too low');
        if (q.v4.liquidity <= 0n || !Number.isFinite(q.volPct)) throw new Error('invalid qualified pool state');
        const {ethers} = await import('ethers');
        const {C} = await import('../config.js');
        const {provider} = await import('../chain/client.js');
        const {STATEVIEW_ABI} = await import('../chain/v4/abis.js');
        if (!C.v4StateView) throw new Error('StateView unavailable');
        const sv = new ethers.Contract(C.v4StateView, STATEVIEW_ABI, provider);
        const [slot,liq] = await Promise.all([sv.getSlot0!(q.v4.poolId),sv.getLiquidity!(q.v4.poolId)]);
        if (BigInt(liq) <= 0n || BigInt(slot.sqrtPriceX96) <= 0n) throw new Error('qualified pool currently empty');
        q.v4 = {...q.v4,liquidity:BigInt(liq),sqrtPriceX96:BigInt(slot.sqrtPriceX96),tick:Number(slot.tick),lpFee:Number(slot.lpFee)};
        const mint = await import('../chain/v4/mint.js');
        const price = await freshEntryPrice();
        const before = await strictCashSnapshot();
        if (!Number.isFinite(a.sizeUsd) || a.sizeUsd <= 0 || a.sizeUsd > 30) throw new Error('pilot size must be at most $30');
        sizeEth = a.sizeUsd / price.usd;
        if (!Number.isFinite(sizeEth) || sizeEth <= 0 || before.eth < GAS_RESERVE || before.eth + before.weth - GAS_RESERVE < sizeEth) throw new Error('insufficient or invalid wallet balances');
        if (Date.now() - price.observedAt > 60_000 || Date.now() < price.observedAt) throw new Error('entry price stale');
        const finalSecurity = securityFailure(g,a.maxTaxPct,Date.now());
        if (finalSecurity) throw new Error(finalSecurity);
        return {q,mint,price,before,g,sizeEth,sizeUsd:a.sizeUsd,mode:a.mode};
      },
      reserve: p => reservationId=riskStore.reserveEntry({token:candidate.token,sizeUsd:p.sizeUsd,sizeEth:p.sizeEth}),
      execute: async p => {
        const width = Math.max(6,Math.min(24,Math.round(8+p.q.volPct/5)));
        const amount = p.sizeEth.toFixed(18);
        const strict={fixedEntryPrice:p.price.usd,priceObservedAt:p.price.observedAt,sizeUsd:p.sizeUsd,expectedPoolId:p.q.v4.poolId,assertActive:()=>{
          const securityBlock=securityFailure(p.g,cfg.autoLp.maxTaxPct,Date.now());
          if(securityBlock)throw new Error(securityBlock);
          const activityBlock=poolActivityFailure(p.q,activityLimits(candidate.source,cfg.watch,cfg.autoLp),Date.now());
          if(activityBlock)throw new Error(activityBlock);
          validateExitSettings(cfg.autoLp);
          if(cfg.autoLp.slPct<=0 || (cfg.autoLp.tpPct<=0&&cfg.autoLp.trailActivationPct<=0))throw new Error('required exit protection unavailable');
          if (Date.now()<p.price.observedAt || Date.now()-p.price.observedAt>60_000) throw new Error('entry price expired before broadcast');
          const session=riskStore.snapshot();
          if (!cfg.autoLp.enabled || cfg.autoLp.entryPaused || !session || session.paused || session.lossTriggered || !session.entries.some(e=>e.id===reservationId&&e.status==='reserved')) throw new Error('entry paused during execution');
        }};
        const opened = p.mode === 'inrange'
          ? await p.mint.openV4UsdgInRange(p.q.v4,amount,{widthSpacings:width,strict})
          : await p.mint.openV4UsdgSingleSide(p.q.v4,amount,{strict});
        if (!opened.tokenId || opened.poolId.toLowerCase() !== p.q.v4.poolId.toLowerCase()) throw new Error('mint identity uncertain');
        if(!Number.isSafeInteger(opened.blockNumber)||opened.blockNumber!<=0)throw new Error('final entry receipt block unavailable');
        const after = await strictCashSnapshot(opened.blockNumber);
        if (after.blockNumber < p.before.blockNumber) throw new Error('wallet snapshot moved backwards');
        if (after.usdg !== p.before.usdg) throw new Error('USDG changed: entry cash basis would require a peg assumption');
        const basisUsd = entryBasisUsd(p.before,after,p.price.usd);
        await strictInventory([...riskStore.openPositions().map(r=>r.tokenId),opened.tokenId]);
        return {opened,basisUsd};
      },
      commit: (id,r) => riskStore.commitEntry(id,{tokenId:r.opened.tokenId!,basisUsd:r.basisUsd}),
      fail: id => riskStore.failEntry(id),
    });
    return {opened:true,reason:'opened',token:candidate.token,symbol:candidate.symbol,sizeEth,result:result.opened};
  } catch (e) {
    return skip(`entry blocked/uncertain: ${(e as Error).message.slice(0,180)}`);
  }
}

/** Rebalance is a new entry, not a loophole through the bounded pilot. */
export async function reopenRecentered(_token:string,_symbol:string):Promise<OpenLike|null> { return null; }

/** Status uses the same durable reservations as entry limits, including partial attempts. */
export function autoLpStatus(): {spentToday:number;opensToday:number;lastHour:number} {
  const now=Date.now();
  const today=(riskStore.snapshot()?.entries??[]).filter(o=>now>=o.at&&now-o.at<86_400_000);
  return {spentToday:today.reduce((s,o)=>s+o.sizeEth,0),opensToday:today.length,lastHour:today.filter(o=>now-o.at<3_600_000).length};
}
