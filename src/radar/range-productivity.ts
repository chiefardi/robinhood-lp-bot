/** Pinned observations only: occupancy and accrual are sampled, never historical truth. */
import {z} from 'zod';
const number=z.number().finite().nonnegative();
const raw=z.string().regex(/^\d+$/).max(78);
export const assetObservationSchema=z.object({
 address:z.string().regex(/^0x[0-9a-f]{40}$/),decimals:z.number().int().min(0).max(36),symbol:z.string().min(1).max(64),
 principalRaw:raw,feesRaw:raw,indicativeFeeUsd:number.optional(),
}).strict();
export const valuationSchema=z.object({
 tokenId:raw,poolId:z.string().regex(/^0x[0-9a-f]{64}$/),expectedNetUsd:number,
 slippageHaircutUsd:number,gasReserveUsd:number,inRange:z.boolean(),assets:z.tuple([assetObservationSchema,assetObservationSchema]),
}).strict();
export type Valuation=z.infer<typeof valuationSchema>;
const measuredAssetSchema=assetObservationSchema.pick({address:true,decimals:true,symbol:true}).extend({
 baselineRaw:raw,accruedRaw:raw,measuredSeconds:number,status:z.enum(['baseline','measured','reset','gap']),
}).strict();
export const productivitySchema=z.object({
 monitoredStart:z.number().positive(),lastAt:z.number().positive(),lastInRange:z.boolean(),runId:z.string(),
 observedSeconds:number,inRangeSeconds:number,unknownSeconds:number,firstInRangeAt:z.number().positive().optional(),
 assets:z.tuple([measuredAssetSchema,measuredAssetSchema]),
}).strict().refine(p=>p.lastAt>=p.monitoredStart&&p.inRangeSeconds<=p.observedSeconds&&
 Math.abs(p.observedSeconds+p.unknownSeconds-(p.lastAt-p.monitoredStart)/1000)<0.001&&
 (p.firstInRangeAt==null||(p.firstInRangeAt>=p.monitoredStart&&p.firstInRangeAt<=p.lastAt))&&
 p.assets.every(a=>a.measuredSeconds<=p.observedSeconds),'Inconsistent sampled coverage');
type Productivity=z.infer<typeof productivitySchema>;
export function sampleProductivity(previous:Productivity|undefined,q:Valuation,at:number,runId:string):Productivity {
 if(previous&&at<=previous.lastAt)return previous;
 const seconds=previous?(at-previous.lastAt)/1000:0;
 const known=!!previous&&previous.runId===runId&&seconds<=90;
 const assets=q.assets.map((a,i)=>{
  const old=previous?.assets[i];
  const identity=old&&old.address===a.address&&old.decimals===a.decimals&&old.symbol===a.symbol;
  const reset=!!old&&(!identity||BigInt(a.feesRaw)<BigInt(old.baselineRaw));
  const measured=known&&identity&&!reset;
  return {address:a.address,decimals:a.decimals,symbol:a.symbol,baselineRaw:a.feesRaw,
   accruedRaw:reset?'0':(BigInt(old?.accruedRaw??'0')+(measured?BigInt(a.feesRaw)-BigInt(old!.baselineRaw):0n)).toString(),
   measuredSeconds:reset?0:(old?.measuredSeconds??0)+(measured?seconds:0),
   status:reset?'reset':!previous?'baseline':measured?'measured':'gap'};
 });
 return productivitySchema.parse({monitoredStart:previous?.monitoredStart??at,lastAt:at,lastInRange:q.inRange,runId,
  observedSeconds:(previous?.observedSeconds??0)+(known?seconds:0),
  inRangeSeconds:(previous?.inRangeSeconds??0)+(known&&previous!.lastInRange&&q.inRange?seconds:0),
  unknownSeconds:(previous?.unknownSeconds??0)+(previous&&!known?seconds:0),
  firstInRangeAt:previous?.firstInRangeAt??(q.inRange?at:undefined),assets});
}
export function productivityLines(p:Productivity|undefined,now:number):string[] {
 if(!p)return ['Sampled range productivity: unavailable (no monitoring baseline).'];
 const unknown=p.unknownSeconds+Math.max(0,(now-p.lastAt)/1000);
 const total=p.observedSeconds+unknown;
 return [`Sampled in-range: ${p.observedSeconds>0?(100*p.inRangeSeconds/p.observedSeconds).toFixed(1)+'%':'unavailable'}; observed ${p.observedSeconds.toFixed(0)}s / ${total.toFixed(0)}s, unknown/gap ${unknown.toFixed(0)}s. Not exact historical occupancy.`,
  `Monitoring since ${new Date(p.monitoredStart).toISOString()}; first observed in range: ${p.firstInRangeAt?new Date(p.firstInRangeAt).toISOString():'not observed'}.`,
  ...p.assets.map(a=>`Fee accrual ${a.symbol} (${a.address}, ${a.decimals} decimals): ${a.status==='measured'&&a.measuredSeconds>0?`${(BigInt(a.accruedRaw)*3600000n/BigInt(Math.round(a.measuredSeconds*1000))).toString()} raw units/h over ${a.measuredSeconds.toFixed(0)}s`:`unavailable (${a.status} baseline)`}.`),
 ];
}
