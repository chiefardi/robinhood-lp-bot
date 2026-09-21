import type { ScreenResult } from './screen.js';
import type { DexPair } from '../chain/dexscreener.js';
import { poolActivityFailure } from './entry-guard.js';
import { USDG } from '../chain/v4/discover.js';
import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';

export interface ActivityCoverage {persistent:boolean;observations:number;spanSeconds:number;reason:string}
const observation=z.object({at:z.number().int().positive(),eligible:z.boolean()}).strict();
const historySchema=z.array(z.object({id:z.string().regex(/^4663:v4:0x[0-9a-f]{64}$/),currencies:z.string().regex(/^0x[0-9a-f]{40}:0x[0-9a-f]{40}$/),samples:z.array(observation).max(128).refine(s=>s.every((x,i)=>i===0||x.at>s[i-1]!.at))}).strict()).max(512).refine(rows=>new Set(rows.map(r=>r.id)).size===rows.length);
type History=z.infer<typeof historySchema>;
const historyKey=(id:string)=>`4663:v4:${id.toLowerCase()}`;
/** PoolId commits the full v4 PoolKey; chain/version prevent cross-chain borrowing. */
export class PoolActivityHistory {
 private rows:History=[];
 constructor(private file:string){try{this.rows=historySchema.parse(JSON.parse(fs.readFileSync(file,'utf8')));}catch{this.rows=[];}}
 record(p:DexPair,limits:FastHuntLimits,now=Date.now()):void {
  if(!/^0x[0-9a-f]{64}$/i.test(p.pairAddr)||!/^0x[0-9a-f]{40}$/i.test(p.baseTokenAddress)||!/^0x[0-9a-f]{40}$/i.test(p.quoteTokenAddress)||
    !Number.isSafeInteger(p.observedAt)||p.observedAt!>now||now-p.observedAt!>60_000||p.observedAt!<=0)return;
  this.rows=this.rows.map(r=>({...r,samples:r.samples.filter(s=>s.at>=now-1800000&&s.at<=now)})).filter(r=>r.samples.length);
  const id=historyKey(p.pairAddr),currencies=[p.baseTokenAddress.toLowerCase(),p.quoteTokenAddress.toLowerCase()].sort().join(':');
  let row=this.rows.find(r=>r.id===id);
  if(row&&row.currencies!==currencies){this.rows=this.rows.filter(r=>r.id!==id);row=undefined;}
  if(!row){row={id,currencies,samples:[]};this.rows.push(row);}
  if(row.samples.some(s=>s.at===p.observedAt)||row.samples.some(s=>s.at>p.observedAt!))return;
  row.samples.push({at:p.observedAt!,eligible:eligibleExactPool(p,limits,now)});row.samples=row.samples.slice(-128);
  this.rows.sort((a,b)=>b.samples.at(-1)!.at-a.samples.at(-1)!.at);this.rows=this.rows.slice(0,512);
  try {fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=`${this.file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(this.rows));fs.renameSync(tmp,this.file);}catch{this.rows=[];}
 }
 coverage(poolId:string,now=Date.now()):ActivityCoverage {
  const samples=this.rows.find(r=>r.id===historyKey(poolId))?.samples.filter(s=>s.at>=now-1800000&&s.at<=now)??[];
  let contiguous:typeof samples=[];
  for(const s of samples){if(!s.eligible){contiguous=[];continue;}if(contiguous.length&&s.at-contiguous.at(-1)!.at>360000)contiguous=[];contiguous.push(s);}
  const span=contiguous.length?(contiguous.at(-1)!.at-contiguous[0]!.at)/1000:0;
  const persistent=contiguous.length>=3&&span>=300&&now-contiguous.at(-1)!.at<=60000;
  return {persistent,observations:contiguous.length,spanSeconds:span,reason:persistent?'Repeated eligible snapshots; not independent volume buckets or organic-volume proof':!samples.length?'Unknown: no fresh retained exact-pool history':'Unknown persistence: insufficient span/count, stale latest sample or interrupted sampling'};
 }
}
export function rankHuntDispatch<T extends {pool:{vol5m?:number;activity?:ActivityCoverage}}>(rows:T[]):T[] {
 return [...rows].sort((a,b)=>Number(!!b.pool.activity?.persistent)-Number(!!a.pool.activity?.persistent)||(b.pool.vol5m??0)-(a.pool.vol5m??0));
}
export function formatActivityCoverage(a:ActivityCoverage|undefined):string {
 return a?`${a.observations} repeated snapshots / ${(a.spanSeconds/60).toFixed(1)}m; ${a.reason}`:'Unknown: exact-pool history unavailable';
}

export interface FastHuntLimits {
  minVolUsd:number;minPoolFeesUsd:number;feeMaxPpm:number;minPoolLiqUsd:number;
  minVol5m:number;minVol1h:number;
}

function eligibleExactPool(p:DexPair,limits:FastHuntLimits,now:number):boolean {
 const v4=p.version.toLowerCase()==='v4'||(p.version===''&&/^0x[0-9a-f]{64}$/i.test(p.pairAddr));
 return v4&&Number.isFinite(p.vol24h)&&p.vol24h>=limits.minVolUsd&&p.vol24h*limits.feeMaxPpm/1e6>=limits.minPoolFeesUsd&&
  (p.baseTokenAddress?.toLowerCase()===USDG.toLowerCase()||p.quoteTokenAddress?.toLowerCase()===USDG.toLowerCase())&&
  !(p.liqUsd>0&&p.liqUsd<limits.minPoolLiqUsd)&&fastPoolScore(p,limits,now)!==null;
}
export function rankExactPoolCandidates(rows:ScreenResult[],pairsByToken:Map<string,Map<string,DexPair>>,limits:FastHuntLimits,now=Date.now(),history?:PoolActivityHistory):Array<{result:ScreenResult;vol5m:number;activity?:ActivityCoverage}> {
  const ranked:Array<{result:ScreenResult;vol5m:number;activity?:ActivityCoverage}>=[];
  for(const result of rows){
    let best:{vol5m:number;activity?:ActivityCoverage}|undefined;
    for(const p of pairsByToken.get(result.token.address.toLowerCase())?.values()??[]){
      if(!eligibleExactPool(p,limits,now))continue;
      const current={vol5m:p.vol5m!,activity:history?.coverage(p.pairAddr,now)};
      if(!best||Number(!!current.activity?.persistent)>Number(!!best.activity?.persistent)||(!!current.activity?.persistent===!!best.activity?.persistent&&current.vol5m>best.vol5m))best=current;
    }
    if(best&&best.vol5m>0)ranked.push({result,...best});
  }
  return ranked.sort((a,b)=>Number(!!b.activity?.persistent)-Number(!!a.activity?.persistent)||b.vol5m-a.vol5m);
}

export function fastPoolScore(pool:{vol5m?:number;volH1?:number;buys5m?:number;sells5m?:number;observedAt?:number},limits:FastHuntLimits,now=Date.now()):number|null {
  if(limits.minVol5m<=0||limits.minVol1h<=0||poolActivityFailure(pool,{minVol5m:limits.minVol5m,minVol1h:limits.minVol1h},now))return null;
  const m5=Math.min(12,Math.log2(pool.vol5m!/limits.minVol5m)*5);
  const h1=Math.min(13,Math.log2(pool.volH1!/limits.minVol1h)*5);
  return Math.min(100,75+Math.round(m5+h1));
}
