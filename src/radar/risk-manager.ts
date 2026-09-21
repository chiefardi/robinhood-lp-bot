import { RiskStore, validateExitSettings, type ExitSettings, type ExitSnapshot, type RiskReason } from './auto-risk.js';
export interface RiskCloseNotice {tokenId:string;token:string;reason:RiskReason;estimatedPnlPct:number|null;realizedPnlUsd:number;realizedPnlPct:number;estimateDifferenceUsd:number}
interface Dependencies {
  isEnabled?:()=>boolean;
  entriesPaused?:()=>boolean;
  recoveryHealth?:()=>Promise<{observedAt:number}>;
  quote:(id:string)=>Promise<ExitSnapshot>;
  acquire:()=>boolean;release:()=>void;
  settle:(id:string,reason:RiskReason)=>Promise<number>;
  notify:(notice:RiskCloseNotice)=>void;warn:(message:string)=>void;
}
/** One serial risk cycle. Pausing entries never pauses this exit path. */
export async function runRiskCycle(store:RiskStore,settings:ExitSettings,d:Dependencies):Promise<void> {
  // Hold the wallet lock for valuation too: a reserved mint must not be mistaken
  // for a crashed/unknown entry halfway through its funding transactions.
  if(!d.acquire())return;
  try {await runLockedCycle(store,settings,d);}finally{d.release();}
}
async function runLockedCycle(store:RiskStore,settings:ExitSettings,d:Dependencies):Promise<void> {
  const fresh=new Set<string>();
  for(const p of store.openPositions()) {
    if(p.status!=='open')continue;
    try {store.evaluatePosition(p.tokenId,await d.quote(p.tokenId),settings);fresh.add(p.tokenId);}
    catch {store.resetRecovery('Fresh liquidation quote unavailable');store.pauseDataEntries('Fresh liquidation quote unavailable');d.warn(`Position #${p.tokenId}: quote unavailable; entries paused, no fabricated mark`);}
  }
  store.sessionLossCheck();
  for(const p of store.openPositions()) {
    if(store.executionBlocked())break;
    if(d.isEnabled&&!d.isEnabled())break;
    if(p.status!=='open'||!p.closeReason||p.closeReason==='ENTRY_ABORT'||!fresh.has(p.tokenId))continue;
    let began=false,settled=false;
    try {
      // Earlier closes and later quote calls can age the initial cycle snapshot.
      const finalQuote=await d.quote(p.tokenId);
      store.evaluatePosition(p.tokenId,finalQuote,settings);
      if(d.isEnabled&&!d.isEnabled())break;
      store.beginClose(p.tokenId);began=true;
      const netUsd=await d.settle(p.tokenId,p.closeReason);
      store.finishClose(p.tokenId,netUsd);
      settled=true;
      d.notify({tokenId:p.tokenId,token:p.token,reason:p.closeReason,
        estimatedPnlPct:(finalQuote.netUsd/p.basisUsd-1)*100,estimateDifferenceUsd:netUsd-finalQuote.netUsd,
        realizedPnlUsd:netUsd-p.basisUsd,realizedPnlPct:(netUsd/p.basisUsd-1)*100});
    }catch(error:any) {
      if(!began){store.resetRecovery('Fresh pre-close quote unavailable');store.pauseDataEntries('Fresh liquidation quote unavailable');d.warn(`Position #${p.tokenId}: fresh pre-close quote unavailable; no transaction sent`);continue;}
      const notBroadcast=error?.broadcastPossible===false;
      if(began&&!settled){if(notBroadcast)store.cancelUnbroadcastClose(p.tokenId);else store.failClose(p.tokenId);}
      d.warn(settled?`Position #${p.tokenId}: cash settlement recorded; notification failed`:notBroadcast?`Position #${p.tokenId}: close stopped before broadcast; entries paused`:`Position #${p.tokenId}: close requires reconciliation; automatic retry blocked`);
    }
  }
  const expected=store.snapshot();
  if(!expected?.paused||expected.pauseKind!=='data'||!d.recoveryHealth)return;
  if(!d.isEnabled?.()||d.entriesPaused?.()!==false){store.resetRecovery('Recovery inactive: monitoring off or configuration pause');return;}
  try {
    validateExitSettings(settings);
    if(settings.slPct<=0||(settings.tpPct<=0&&settings.trailActivationPct<=0))throw Error('Required exit protection unavailable');
    if(store.executionBlocked()||store.openPositions().some(p=>p.closeReason||!fresh.has(p.tokenId)))throw Error('Unresolved execution, latched exit or missing fresh quote');
    const health=await d.recoveryHealth();
    // /auto pause is synchronous and can run during awaited health work despite txlock.
    if(!d.isEnabled?.()||d.entriesPaused?.()!==false){store.resetRecovery('Recovery stopped by operator/configuration');return;}
    validateExitSettings(settings);
    if(settings.slPct<=0||(settings.tpPct<=0&&settings.trailActivationPct<=0))throw Error('Required exit protection unavailable');
    store.sessionLossCheck();
    if(store.sampleRecovery(expected,health.observedAt))d.warn('Data outage recovered after healthy checks; screened entries eligible again');
  }catch{store.resetRecovery('Recovery health unavailable: nonce, inventory, funding or protection check failed');}
}
