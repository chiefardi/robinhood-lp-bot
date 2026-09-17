/** Vendor-tag screening, NOT complete beneficial-ownership detection.
 * All rates use total supply. Unobserved supply is included in the risk bound.
 * Pool/burn rows are custody exclusions, never called independent safe holders.
 */
export interface HolderEvidence {
  status:'ok'|'unknown'; observedAt:number; reason?:string;
  rows?:number; coverageRate?:number; unobservedRate?:number; custodyRate?:number;
  taggedRiskRate?:number; taggedRiskUpperRate?:number;
  largestWalletRate?:number; top10WalletRate?:number; largestSharedFunderRate?:number;
}
const ADDRESS=/^0x[0-9a-f]{40}$/i;
const RISK_TAGS=new Set(['bundler','rat_trader','sniper','dev_team','creator']);
export function analyzeHolderCoverage(raw:unknown,observedAt:number):HolderEvidence {
  const unknown=(reason:string):HolderEvidence=>({status:'unknown',observedAt,reason});
  const list=(raw as {list?:unknown})?.list;
  if(!Array.isArray(list)||list.length===0||list.length>100)return unknown('holder list missing or invalid');
  const seen=new Set<string>(), normal:number[]=[], funders=new Map<string,{count:number;rate:number}>();
  let coverage=0,custody=0,risk=0;
  for(const r of list){
    if(!r||typeof r.address!=='string'||!ADDRESS.test(r.address))return unknown('invalid holder address');
    const address=r.address.toLowerCase();
    if(seen.has(address))return unknown('duplicate holder');seen.add(address);
    if(!['string','number'].includes(typeof r.amount_percentage)||String(r.amount_percentage).trim()==='')return unknown('holder share missing');
    const rate=Number(r.amount_percentage);
    if(!Number.isFinite(rate)||rate<0||rate>1||![0,1,2].includes(r.addr_type))return unknown('invalid share or custody class');
    if(!Array.isArray(r.maker_token_tags)||r.maker_token_tags.some((t:unknown)=>typeof t!=='string'))return unknown('holder tags unavailable');
    coverage+=rate;
    if(r.addr_type!==0){custody+=rate;continue;}
    normal.push(rate);
    if(r.maker_token_tags.some((t:string)=>RISK_TAGS.has(t)))risk+=rate;
    const funder=r.native_transfer?.from_address;
    if(typeof funder==='string'&&ADDRESS.test(funder)&&!/^0x0{40}$/i.test(funder)){
      const key=funder.toLowerCase(),group=funders.get(key)??{count:0,rate:0};
      group.count++;group.rate+=rate;funders.set(key,group);
    }
  }
  if(coverage>1+1e-6)return unknown('holder supply sum exceeds total');
  if(1-custody<.02)return unknown('tradeable float too small to assess');
  const unseen=Math.max(0,1-coverage);
  normal.sort((a,b)=>b-a);
  return {status:'ok',observedAt,rows:list.length,coverageRate:Math.min(1,coverage),unobservedRate:unseen,custodyRate:custody,
    taggedRiskRate:risk,taggedRiskUpperRate:Math.min(1,risk+unseen),largestWalletRate:normal[0]??0,
    top10WalletRate:normal.slice(0,10).reduce((a,b)=>a+b,0),
    largestSharedFunderRate:Math.max(0,...[...funders.values()].filter(g=>g.count>=2).map(g=>g.rate))};
}

export function holderFailure(e:HolderEvidence|undefined,now:number):string|null {
  if(!e||e.status!=='ok')return 'holder coverage unknown: '+(e?.reason??'no live holder evidence');
  if(!Number.isFinite(e.observedAt)||e.observedAt<=0||e.observedAt>now||now-e.observedAt>60_000)return 'holder evidence stale or invalid';
  const rates=[e.coverageRate,e.unobservedRate,e.custodyRate,e.taggedRiskRate,e.taggedRiskUpperRate,e.largestWalletRate,e.top10WalletRate,e.largestSharedFunderRate];
  if(rates.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1))return 'holder evidence invalid';
  if(e.coverageRate!<.70-1e-9)return 'holder coverage below 70%; too much unobserved supply';
  if(e.taggedRiskUpperRate!>.30+1e-9)return 'tagged risk plus unobserved supply exceeds 30%';
  if(e.largestWalletRate!>.10+1e-9||e.top10WalletRate!>.50+1e-9)return 'normal-wallet concentration exceeds limit';
  if(e.largestSharedFunderRate!>.20+1e-9)return 'observed shared-funder group exceeds 20% (not ownership proof)';
  return null;
}
