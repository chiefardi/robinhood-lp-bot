import type { ScreenResult } from './screen.js';
import type { DexPair } from '../chain/dexscreener.js';
import { poolActivityFailure } from './entry-guard.js';

export interface FastHuntLimits {
  minVolUsd:number;minPoolFeesUsd:number;feeMaxPpm:number;minPoolLiqUsd:number;
  minVol5m:number;minVol1h:number;
}

export function rankExactPoolCandidates(rows:ScreenResult[],pairsByToken:Map<string,Map<string,DexPair>>,limits:FastHuntLimits,now=Date.now()):Array<{result:ScreenResult;vol5m:number}> {
  const ranked:Array<{result:ScreenResult;vol5m:number}>=[];
  for(const result of rows){
    let best=0;
    for(const p of pairsByToken.get(result.token.address.toLowerCase())?.values()??[]){
      const v4=p.version.toLowerCase()==='v4'||(p.version===''&&/^0x[0-9a-f]{64}$/i.test(p.pairAddr));
      if(!v4||!Number.isFinite(p.vol24h)||p.vol24h<limits.minVolUsd||p.vol24h*limits.feeMaxPpm/1e6<limits.minPoolFeesUsd)continue;
      if(p.liqUsd>0&&p.liqUsd<limits.minPoolLiqUsd)continue;
      if(fastPoolScore(p,limits,now)===null)continue;
      best=Math.max(best,p.vol5m!);
    }
    if(best>0)ranked.push({result,vol5m:best});
  }
  return ranked.sort((a,b)=>b.vol5m-a.vol5m);
}

export function fastPoolScore(pool:{vol5m?:number;volH1?:number;buys5m?:number;sells5m?:number;observedAt?:number},limits:FastHuntLimits,now=Date.now()):number|null {
  if(limits.minVol5m<=0||limits.minVol1h<=0||poolActivityFailure(pool,{minVol5m:limits.minVol5m,minVol1h:limits.minVol1h},now))return null;
  const m5=Math.min(12,Math.log2(pool.vol5m!/limits.minVol5m)*5);
  const h1=Math.min(13,Math.log2(pool.volH1!/limits.minVol1h)*5);
  return Math.min(100,75+Math.round(m5+h1));
}
