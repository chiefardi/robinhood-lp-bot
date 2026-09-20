import { RiskStore, type ExitSettings, type ExitSnapshot, type RiskReason } from './auto-risk.js';
export interface RiskCloseNotice {tokenId:string;token:string;reason:RiskReason;estimatedPnlPct:number|null;realizedPnlUsd:number;realizedPnlPct:number}
interface Dependencies {
  isEnabled?:()=>boolean;
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
    catch {store.pauseEntries('Fresh liquidation quote unavailable');d.warn(`Position #${p.tokenId}: quote unavailable; entries paused, no fabricated mark`);}
  }
  store.sessionLossCheck();
  for(const p of store.openPositions()) {
    if(store.executionBlocked())break;
    if(d.isEnabled&&!d.isEnabled())break;
    if(p.status!=='open'||!p.closeReason||!fresh.has(p.tokenId))continue;
    let began=false,settled=false;
    try {
      // Earlier closes and later quote calls can age the initial cycle snapshot.
      store.evaluatePosition(p.tokenId,await d.quote(p.tokenId),settings);
      if(d.isEnabled&&!d.isEnabled())break;
      store.beginClose(p.tokenId);began=true;
      const netUsd=await d.settle(p.tokenId,p.closeReason);
      store.finishClose(p.tokenId,netUsd);
      settled=true;
      d.notify({tokenId:p.tokenId,token:p.token,reason:p.closeReason,
        estimatedPnlPct:p.markUsd==null?null:(p.markUsd/p.basisUsd-1)*100,
        realizedPnlUsd:netUsd-p.basisUsd,realizedPnlPct:(netUsd/p.basisUsd-1)*100});
    }catch(error:any) {
      if(!began){store.pauseEntries('Fresh liquidation quote unavailable');d.warn(`Position #${p.tokenId}: fresh pre-close quote unavailable; no transaction sent`);continue;}
      const notBroadcast=error?.broadcastPossible===false;
      if(began&&!settled){if(notBroadcast)store.cancelUnbroadcastClose(p.tokenId);else store.failClose(p.tokenId);}
      d.warn(settled?`Position #${p.tokenId}: cash settlement recorded; notification failed`:notBroadcast?`Position #${p.tokenId}: close stopped before broadcast; entries paused`:`Position #${p.tokenId}: close requires reconciliation; automatic retry blocked`);
    }
  }
}
