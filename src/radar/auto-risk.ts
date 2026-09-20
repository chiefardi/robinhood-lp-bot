/** Dedicated pilot ledger. Cash basis and cumulative session history are immutable.
 * Missing/corrupt state, unknown execution, and stale marks fail closed for new entries.
 * All methods are synchronous, and callers serialize wallet actions with txlock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dataPath } from '../util/files.js';

const positive = z.number().finite().positive();
const reasonSchema = z.enum(['TP','SL','TRAIL','SESSION','TIME_TP','MAX_HOLD']);
export type RiskReason = z.infer<typeof reasonSchema>;
// Operator-only proof for a pristine wallet. This cannot clear an attempted broadcast.
const noBroadcastSchema = z.object({
  chainId:z.literal(4663),wallet:z.string().regex(/^0x[0-9a-f]{40}$/i),
  blockNumber:z.number().int().positive(),blockHash:z.string().regex(/^0x[0-9a-f]{64}$/i),observedAt:positive,
  latestNonce:z.literal(0),pendingNonce:z.literal(0),nativeWei:z.string().regex(/^\d+$/),expectedNativeWei:z.string().regex(/^\d+$/),
  wethWei:z.literal('0'),usdgRaw:z.literal('0'),v3Count:z.literal(0),v4Count:z.literal(0),reason:z.string().min(10),
}).strict().refine(e=>BigInt(e.nativeWei)===BigInt(e.expectedNativeWei)&&BigInt(e.nativeWei)>0n,'Initial funding balance changed');
const entrySchema = z.object({
  id:z.string(),token:z.string(),sizeUsd:positive,sizeEth:positive,at:positive,
  status:z.enum(['reserved','open','closing','closed','uncertain','aborted']),
  noBroadcastEvidence:noBroadcastSchema.optional(),
  tokenId:z.string().optional(),basisUsd:positive.optional(),
  peakPct:z.number().finite().optional(),armed:z.boolean().default(false),
  markUsd:z.number().finite().nonnegative().optional(),markAt:positive.optional(),
  blockNumber:z.number().int().nonnegative().optional(),
  closeReason:reasonSchema.optional(),realizedNetUsd:z.number().finite().optional(),
}).strict().refine(e=>e.status!=='aborted'||(!!e.noBroadcastEvidence&&!e.tokenId&&!e.basisUsd&&!e.closeReason),'Invalid aborted attempt');
const sessionSchema = z.object({
  id:z.string(),startedAt:positive,paused:z.boolean(),pauseReason:z.string(),lossTriggered:z.boolean(),
  entries:z.array(entrySchema),
}).strict();
const stateSchema = z.object({version:z.literal(1),session:sessionSchema.nullable(),history:z.array(sessionSchema)}).strict();
type State=z.infer<typeof stateSchema>;
type Entry=z.infer<typeof entrySchema>;
export interface ExitSettings {tpPct:number;slPct:number;trailActivationPct:number;trailGivebackPct:number;timedTpMin?:number;timedTpPct?:number;maxHoldMin?:number}
export interface ExitSnapshot {netUsd:number;observedAt:number;blockNumber:number}
export const PILOT_LIMITS = Object.freeze({maxOpen:3,outstandingUsd:90,lossUsd:15});
const occupiesSlot = (e:Entry) => e.status !== 'closed' && e.status !== 'aborted';
const outstandingBasis = (entries:Entry[]) => entries.filter(occupiesSlot).reduce((n,e)=>n+Math.max(e.sizeUsd,e.basisUsd??0),0);
export function validateExitSettings(s:ExitSettings):void {
  if(![s.tpPct,s.slPct,s.trailActivationPct,s.trailGivebackPct,s.timedTpMin??0,s.timedTpPct??0,s.maxHoldMin??0].every(x=>Number.isFinite(x)&&x>=0)) throw new Error('Invalid exit settings');
  if(s.trailActivationPct>0 && (s.trailGivebackPct<=0 || s.tpPct>0)) throw new Error('Trailing requires positive giveback and fixed TP off');
  if((s.timedTpMin??0)>0 && (s.timedTpPct??0)<=0)throw new Error('Timed TP requires a positive net profit threshold');
  if((s.maxHoldMin??0)>0 && (s.timedTpMin??0)>s.maxHoldMin!)throw new Error('Timed TP must not start after maximum holding time');
}

export class RiskStore {
  constructor(private file:string,private now:()=>number=Date.now) {}
  private read():State {
    try { return stateSchema.parse(JSON.parse(fs.readFileSync(this.file,'utf8'))); }
    catch(e:any) { if(e?.code==='ENOENT') return {version:1,session:null,history:[]}; throw new Error('Risk state unreadable or invalid; reconciliation required'); }
  }
  private save(s:State):void {
    stateSchema.parse(s);
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    const tmp=`${this.file}.${process.pid}.tmp`;
    const fd=fs.openSync(tmp,'w',0o600);
    try {fs.writeFileSync(fd,JSON.stringify(s,null,2));fs.fsyncSync(fd);} finally{fs.closeSync(fd);}
    fs.renameSync(tmp,this.file);
  }
  snapshot(){return this.read().session;}
  hasSession():boolean{return this.read().session!==null;}
  executionBlocked():boolean{return !!this.read().session?.entries.some(e=>['reserved','closing','uncertain'].includes(e.status));}
  startSession():void {
    const s=this.read();
    if(s.session?.entries.some(e=>e.status!=='closed')) throw new Error('Session has unresolved entries; reconcile first');
    if(s.session) s.history.push(s.session);
    s.session={id:randomUUID(),startedAt:this.now(),paused:true,pauseReason:'New session: entries paused',lossTriggered:false,entries:[]};
    this.save(s);
  }
  pauseEntries(reason='Operator pause'):void {
    const s=this.read();if(!s.session)return;
    s.session.paused=true;s.session.pauseReason=reason;this.save(s);
  }
  resumeEntries():void {
    const s=this.read(),r=s.session;if(!r)throw new Error('Initialize a session first');
    if(r.lossTriggered)throw new Error('Session loss circuit is latched');
    if(r.entries.some(e=>['reserved','closing','uncertain'].includes(e.status)))throw new Error('Pending or uncertain execution requires reconciliation');
    r.paused=false;r.pauseReason='';this.save(s);
  }
  entryBlockReason(sizeUsd=0):string|null {
    try {
      const r=this.read().session;if(!r)return 'Session not initialized';
      if(r.lossTriggered)return 'Cumulative session loss circuit latched';
      if(r.paused)return `Entries paused: ${r.pauseReason}`;
      if(r.entries.some(e=>['reserved','closing','uncertain'].includes(e.status)||e.closeReason&&e.status!=='closed'))return 'Pending or uncertain execution/exit requires settlement';
      if(r.entries.filter(occupiesSlot).length>=PILOT_LIMITS.maxOpen)return 'All 3 concurrent slots occupied';
      const used=outstandingBasis(r.entries);
      if(!Number.isFinite(sizeUsd)||sizeUsd<0||used>=PILOT_LIMITS.outstandingUsd||used+sizeUsd>PILOT_LIMITS.outstandingUsd+1e-8)return 'Outstanding capital budget exceeds $90';
      return null;
    }catch{return 'Risk state unreadable; reconciliation required';}
  }
  entryAllowed(sizeUsd=0):boolean {return this.entryBlockReason(sizeUsd)===null;}
  reserveEntry(input:{token:string;sizeUsd:number;sizeEth:number}):string {
    const blocked=this.entryBlockReason(input.sizeUsd);if(blocked)throw new Error(blocked);
    const s=this.read(),r=s.session!;
    positive.parse(input.sizeUsd);positive.parse(input.sizeEth);
    if(input.sizeUsd>30)throw new Error('Pilot entry size must be at most $30');
    if(!input.token||r.entries.some(e=>occupiesSlot(e)&&e.token.toLowerCase()===input.token.toLowerCase()))throw new Error('Duplicate/invalid token in open slots');
    const id=randomUUID();r.entries.push({...input,id,at:this.now(),status:'reserved',armed:false});this.save(s);return id;
  }
  commitEntry(id:string,input:{tokenId:string;basisUsd:number}):void {
    const s=this.read(),r=s.session!;const e=r?.entries.find(x=>x.id===id);
    if(!e||e.status!=='reserved'||!input.tokenId||r.entries.some(x=>x.tokenId===input.tokenId))throw new Error('Invalid entry commit');
    positive.parse(input.basisUsd);Object.assign(e,input,{status:'open'});
    if(outstandingBasis(r.entries)>PILOT_LIMITS.outstandingUsd){r.paused=true;r.pauseReason='Actual costs exhausted outstanding budget';}
    this.save(s);
  }
  failEntry(id:string):void {
    const s=this.read(),e=s.session?.entries.find(x=>x.id===id);if(!e)throw new Error('Unknown reservation');
    e.status='uncertain';s.session!.paused=true;s.session!.pauseReason='Entry execution/basis uncertain; reconcile';this.save(s);
  }
  reconcileNeverBroadcast(id:string,input:z.infer<typeof noBroadcastSchema>):void {
    const proof=noBroadcastSchema.parse(input);
    if(this.now()<proof.observedAt||this.now()-proof.observedAt>60_000)throw new Error('Reconciliation proof stale');
    const s=this.read(),r=s.session,e=r?.entries.find(x=>x.id===id);
    if(!r||!r.paused||!e||!['reserved','uncertain'].includes(e.status)||e.tokenId||e.basisUsd||e.closeReason)
      throw new Error('Only an unresolved never-broadcast entry can be reconciled');
    e.status='aborted';e.noBroadcastEvidence=proof;
    r.pauseReason='Never-broadcast attempt reconciled; entries remain paused';this.save(s);
  }
  openPositions():Array<Entry & {tokenId:string;basisUsd:number}> {
    return (this.read().session?.entries??[]).filter((e):e is Entry & {tokenId:string;basisUsd:number}=>e.status!=='closed'&&!!e.tokenId&&!!e.basisUsd);
  }
  evaluatePosition(tokenId:string,q:ExitSnapshot,settings:ExitSettings) {
    validateExitSettings(settings);
    const s=this.read(),e=s.session?.entries.find(x=>x.tokenId===tokenId);
    if(!e||!e.basisUsd||e.status!=='open')throw new Error('Position not open for evaluation');
    if(!Number.isFinite(q.netUsd)||q.netUsd<0||!Number.isSafeInteger(q.blockNumber)||q.blockNumber<0||
       !Number.isFinite(q.observedAt)||this.now()-q.observedAt>60_000||q.observedAt>this.now()+1000)throw new Error('Invalid or stale exit quote');
    if((e.blockNumber!=null&&q.blockNumber<e.blockNumber)||(e.markAt!=null&&q.observedAt<e.markAt))throw new Error('Regressing exit snapshot');
    const pnlPct=(q.netUsd/e.basisUsd-1)*100;
    const ageMin=(this.now()-e.at)/60_000;
    if(ageMin<0)throw new Error('Position entry timestamp is in the future');
    e.peakPct=Math.max(e.peakPct??-Infinity,pnlPct);e.markUsd=q.netUsd;e.markAt=q.observedAt;e.blockNumber=q.blockNumber;
    if(settings.trailActivationPct>0 && e.peakPct+1e-8>=settings.trailActivationPct)e.armed=true;
    if(!e.closeReason){
      if(settings.slPct>0&&pnlPct<=-settings.slPct+1e-8)e.closeReason='SL';
      else if(settings.trailActivationPct>0&&e.armed&&pnlPct<=e.peakPct-settings.trailGivebackPct+1e-8)e.closeReason='TRAIL';
      else if(settings.tpPct>0&&pnlPct+1e-8>=settings.tpPct)e.closeReason='TP';
      else if((settings.maxHoldMin??0)>0&&ageMin>=settings.maxHoldMin!)e.closeReason='MAX_HOLD';
      else if((settings.timedTpMin??0)>0&&ageMin>=settings.timedTpMin!&&pnlPct+1e-8>=settings.timedTpPct!)e.closeReason='TIME_TP';
    }
    this.save(s);return {pnlPct,peakPct:e.peakPct,reason:e.closeReason??null};
  }
  sessionLossCheck():boolean {
    const s=this.read(),r=s.session;if(!r)return false;
    if(r.lossTriggered)return true;
    let pnl=0;
    for(const e of r.entries){
      if(e.status==='aborted')continue; // zero cash movement; retained for audit
      if(!e.basisUsd||e.status==='uncertain'||e.status==='closing'||e.status==='reserved') {r.paused=true;r.pauseReason='Incomplete session valuation';this.save(s);return false;}
      const value=e.status==='closed'?e.realizedNetUsd:e.markUsd;
      if(value==null||(e.status!=='closed'&&(!e.markAt||this.now()-e.markAt>60_000))){r.paused=true;r.pauseReason='Missing fresh session valuation';this.save(s);return false;}
      pnl+=value-e.basisUsd;
    }
    if(pnl<=-PILOT_LIMITS.lossUsd){
      r.lossTriggered=true;r.paused=true;r.pauseReason='Session loss limit reached';
      for(const e of r.entries)if(e.status==='open')e.closeReason='SESSION';this.save(s);return true;
    }
    return false;
  }
  beginClose(tokenId:string):void {
    const s=this.read(),e=s.session?.entries.find(x=>x.tokenId===tokenId);
    if(!e||e.status!=='open'||!e.closeReason)throw new Error('Close not armed or already in flight');
    e.status='closing';this.save(s);
  }
  cancelUnbroadcastClose(tokenId:string):void {
    const s=this.read(),e=s.session?.entries.find(x=>x.tokenId===tokenId);
    if(!e||e.status!=='closing')throw new Error('No unbroadcast close to cancel');
    e.status='open';s.session!.paused=true;s.session!.pauseReason='Close preflight stopped before broadcast';this.save(s);
  }
  finishClose(tokenId:string,netUsd:number):void {
    const s=this.read(),e=s.session?.entries.find(x=>x.tokenId===tokenId);
    if(!e||e.status!=='closing'||!Number.isFinite(netUsd))throw new Error('Invalid close settlement');
    e.status='closed';e.realizedNetUsd=netUsd;this.save(s);this.sessionLossCheck();
  }
  failClose(tokenId:string):void {
    const s=this.read(),e=s.session?.entries.find(x=>x.tokenId===tokenId);if(!e)throw new Error('Unknown position');
    e.status='uncertain';s.session!.paused=true;s.session!.pauseReason='Close outcome uncertain; reconcile before any retry';this.save(s);
  }
}
export const riskStore=new RiskStore(dataPath('auto-risk.json'));
