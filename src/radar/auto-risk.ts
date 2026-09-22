/** Dedicated pilot ledger. Cash basis and cumulative session history are immutable.
 * Missing/corrupt state, unknown execution, and stale marks fail closed for new entries.
 * All methods are synchronous, and callers serialize wallet actions with txlock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dataPath } from '../util/files.js';
import {valuationSchema,productivitySchema,sampleProductivity,type Valuation} from './range-productivity.js';

const positive = z.number().finite().positive();
const reasonSchema = z.enum(['TP','SL','TRAIL','SESSION','TIME_TP','MAX_HOLD','ENTRY_ABORT']);
export type RiskReason = Exclude<z.infer<typeof reasonSchema>,'ENTRY_ABORT'>;
// Operator-only proof for a pristine wallet. This cannot clear an attempted broadcast.
const pristineNoBroadcastSchema = z.object({
  chainId:z.literal(4663),wallet:z.string().regex(/^0x[0-9a-f]{40}$/i),
  blockNumber:z.number().int().positive(),blockHash:z.string().regex(/^0x[0-9a-f]{64}$/i),observedAt:positive,
  latestNonce:z.literal(0),pendingNonce:z.literal(0),nativeWei:z.string().regex(/^\d+$/),expectedNativeWei:z.string().regex(/^\d+$/),
  wethWei:z.literal('0'),usdgRaw:z.literal('0'),v3Count:z.literal(0),v4Count:z.literal(0),reason:z.string().min(10),
}).strict().refine(e=>BigInt(e.nativeWei)===BigInt(e.expectedNativeWei)&&BigInt(e.nativeWei)>0n,'Initial funding balance changed');
// Operator-only reconciliation: a reviewed synchronous guard threw before wallet
// access, corroborated by unchanged nonce since a recorded pre-attempt observation.
// Never use this for swap/RPC timeouts or an attempted transaction broadcast.
const rejectedNoBroadcastSchema=z.object({
  kind:z.literal('pre-broadcast-guard'),chainId:z.literal(4663),wallet:z.string().regex(/^0x[0-9a-f]{40}$/i),
  beforeObservedAt:positive,observedAt:positive,beforeNonce:z.number().int().nonnegative(),
  latestNonce:z.number().int().nonnegative(),pendingNonce:z.number().int().nonnegative(),
  blockNumber:z.number().int().positive(),blockHash:z.string().regex(/^0x[0-9a-f]{64}$/i),
  runtimeCommit:z.string().regex(/^[0-9a-f]{40}$/),reason:z.literal('invalid strict pool'),
}).strict().refine(e=>e.beforeNonce===e.latestNonce&&e.latestNonce===e.pendingNonce,'Wallet nonce changed');
const noBroadcastSchema=z.union([pristineNoBroadcastSchema,rejectedNoBroadcastSchema]);
const entryRecoverySchema=z.object({tokenId:z.string().regex(/^\d+$/),cashDebitWei:z.string().regex(/^[1-9]\d*$/),ethUsd:positive,
  observedAt:positive,blockNumber:z.number().int().positive(),receiptHashes:z.array(z.string().regex(/^0x[0-9a-f]{64}$/i)).min(1)}).strict();
const entryUnwindSchema=z.object({cashDebitWei:z.string().regex(/^[1-9]\d*$/),cashReturnWei:z.string().regex(/^\d+$/),entryEthUsd:positive,exitEthUsd:positive,
  observedAt:positive,blockNumber:z.number().int().positive(),receiptHashes:z.array(z.string().regex(/^0x[0-9a-f]{64}$/i)).min(1)}).strict();
const entrySchema = z.object({
  id:z.string(),token:z.string(),sizeUsd:positive,sizeEth:positive,at:positive,
  status:z.enum(['reserved','open','closing','closed','uncertain','aborted']),
  noBroadcastEvidence:noBroadcastSchema.optional(),
  entryRecoveryEvidence:entryRecoverySchema.optional(),
  entryUnwindEvidence:entryUnwindSchema.optional(),
  entryRollbackEvidence:z.object({basisUsd:positive,realizedNetUsd:z.number().finite(),blockNumber:z.number().int().positive(),receiptHashes:z.array(z.string().regex(/^0x[0-9a-f]{64}$/i)).min(1)}).strict().optional(),
  tokenId:z.string().optional(),basisUsd:positive.optional(),
  peakPct:z.number().finite().optional(),armed:z.boolean().default(false),
  markUsd:z.number().finite().nonnegative().optional(),markAt:positive.optional(),
  blockNumber:z.number().int().nonnegative().optional(),
  // Additive diagnostics cannot make a valid financial ledger unreadable.
  valuation:valuationSchema.optional().catch(undefined),productivity:productivitySchema.optional().catch(undefined),
  observationStatus:z.enum(['available','invalid','unavailable']).optional(),
  observedPoolId:z.string().regex(/^0x[0-9a-f]{64}$/).optional(),
  closeReason:reasonSchema.optional(),realizedNetUsd:z.number().finite().optional(),
  closedAt:positive.optional(),
  closeTimeEvidence:z.object({txHash:z.string().regex(/^0x[0-9a-f]{64}$/i),blockNumber:z.number().int().positive()}).strict().optional(),
}).strict().refine(e=>e.status!=='aborted'||(!!e.noBroadcastEvidence&&!e.tokenId&&!e.basisUsd&&!e.closeReason),'Invalid aborted attempt');
const sessionSchema = z.object({
  id:z.string(),startedAt:positive,paused:z.boolean(),pauseReason:z.string(),lossTriggered:z.boolean(),
  pauseKind:z.enum(['manual','data','uncertain','configuration','loss','initial']).optional(),pauseRevision:z.number().int().nonnegative().optional(),
  entries:z.array(entrySchema),
}).strict();
const stateSchema = z.object({version:z.literal(1),session:sessionSchema.nullable(),history:z.array(sessionSchema)}).strict();
type State=z.infer<typeof stateSchema>;
type Entry=z.infer<typeof entrySchema>;
export interface ExitSettings {tpPct:number;slPct:number;trailActivationPct:number;trailGivebackPct:number;timedTpMin?:number;timedTpPct?:number;maxHoldMin?:number}
export interface ExitSnapshot extends Partial<Valuation> {netUsd:number;observedAt:number;blockNumber:number}
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
  private readonly runId=randomUUID();
  private recovery:{sessionId:string;revision:number;first:number;last:number;count:number}|null=null;
  private recoveryMessage='No recovery samples since startup';
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
  reportingSnapshot(){return this.read();}
  /** Operator backfill after on-chain receipt verification; never rewrites accounting. */
  backfillCloseTime(tokenId:string,proof:{closedAt:number;txHash:string;blockNumber:number}):void {
    const s=this.read(),e=s.session?.entries.find(e=>e.tokenId===tokenId);
    if(!e||e.status!=='closed'||e.closedAt!=null)throw new Error('Closed entry absent or timestamp already recorded');
    if(!Number.isSafeInteger(proof.closedAt)||proof.closedAt<Math.max(e.at,e.markAt??0)||proof.closedAt>this.now()||
       !Number.isSafeInteger(proof.blockNumber)||proof.blockNumber<(e.blockNumber??1)||!/^0x[0-9a-f]{64}$/i.test(proof.txHash))throw new Error('Invalid verified close timestamp evidence');
    e.closedAt=proof.closedAt;e.closeTimeEvidence={txHash:proof.txHash,blockNumber:proof.blockNumber};this.save(s);
  }
  hasSession():boolean{return this.read().session!==null;}
  executionBlocked():boolean{return !!this.read().session?.entries.some(e=>['reserved','closing','uncertain'].includes(e.status));}
  startSession():void {
    const s=this.read();
    if(s.session?.entries.some(e=>e.status!=='closed')) throw new Error('Session has unresolved entries; reconcile first');
    if(s.session) s.history.push(s.session);
    s.session={id:randomUUID(),startedAt:this.now(),paused:true,pauseReason:'New session: entries paused',pauseKind:'initial',pauseRevision:1,lossTriggered:false,entries:[]};
    this.save(s);
  }
  pauseEntries(reason='Operator pause'):void {
    const s=this.read();if(!s.session)return;
    this.setPause(s.session,reason,'manual');this.save(s);
  }
  private setPause(r:NonNullable<State['session']>,reason:string,kind:NonNullable<NonNullable<State['session']>['pauseKind']>):void {
    // Transient outages never replace a stronger pause or invent legacy permission.
    if(kind!=='manual'&&r.paused&&r.pauseKind!=='data')return;
    if(!(kind==='data'&&r.paused&&r.pauseKind==='data')){r.pauseRevision=(r.pauseRevision??0)+1;this.resetRecovery('Pause revision changed');}
    r.paused=true;r.pauseReason=reason;r.pauseKind=kind;
  }
  pauseDataEntries(reason:string):void {const s=this.read();if(!s.session)return;this.setPause(s.session,reason,'data');this.save(s);}
  resetRecovery(reason:string):void {this.recovery=null;this.recoveryMessage=reason;}
  recoveryStatus():string{return this.recoveryMessage;}
  /** Called only by the risk cycle under wallet lock after read-only health checks. */
  sampleRecovery(expected:{id:string;pauseRevision?:number},observedAt:number):boolean {
    const s=this.read(),r=s.session,now=this.now();
    if(!r||r.id!==expected.id||!Number.isSafeInteger(r.pauseRevision)||r.pauseRevision!==expected.pauseRevision||!r.paused||r.pauseKind!=='data'||r.lossTriggered||
      r.entries.some(e=>['reserved','closing','uncertain'].includes(e.status)||(e.status!=='closed'&&!!e.closeReason))||
      !Number.isFinite(observedAt)||observedAt>now||now-observedAt>60_000||
      r.entries.some(e=>e.status==='open'&&(e.markAt==null||e.markAt>now||now-e.markAt>60_000))){this.resetRecovery('Recovery blocked: pause changed, execution unresolved or health stale');return false;}
    let streak=this.recovery;
    if(!streak||streak.sessionId!==r.id||streak.revision!==r.pauseRevision||now-streak.last>90_000||now<streak.last)
      streak=this.recovery={sessionId:r.id,revision:r.pauseRevision!,first:now,last:now,count:1};
    else if(now-streak.last>=20_000){streak.last=now;streak.count++;}
    this.recoveryMessage=`Data recovery: ${streak.count} successful samples, ${Math.floor((now-streak.first)/1000)}s span (need 3 / 60s)`;
    if(streak.count<3||now-streak.first<60_000)return false;
    r.paused=false;r.pauseReason='';r.pauseKind=undefined;r.pauseRevision=(r.pauseRevision??0)+1;this.save(s);
    this.resetRecovery('Data pause recovered after spaced healthy checks');return true;
  }
  resumeEntries():void {
    const s=this.read(),r=s.session;if(!r)throw new Error('Initialize a session first');
    if(r.lossTriggered)throw new Error('Session loss circuit is latched');
    if(r.entries.some(e=>['reserved','closing','uncertain'].includes(e.status)))throw new Error('Pending or uncertain execution requires reconciliation');
    r.paused=false;r.pauseReason='';r.pauseKind=undefined;r.pauseRevision=(r.pauseRevision??0)+1;this.resetRecovery('Operator resume');this.save(s);
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
    if(outstandingBasis(r.entries)>PILOT_LIMITS.outstandingUsd)this.setPause(r,'Actual costs exhausted outstanding budget','configuration');
    this.save(s);
  }
  failEntry(id:string):void {
    const s=this.read(),e=s.session?.entries.find(x=>x.id===id);if(!e)throw new Error('Unknown reservation');
    e.status='uncertain';this.setPause(s.session!,'Entry execution/basis uncertain; reconcile','uncertain');this.save(s);
  }
  /** Called under the entry lock only after confirmed rollback and restored inventory.
   * Cash snapshots bracket purchases and refunds separately, each including gas. */
  commitEntryRollback(id:string,proof:{basisUsd:number;realizedNetUsd:number;blockNumber:number;receiptHashes:string[]}):void {
    const s=this.read(),r=s.session,e=r?.entries.find(x=>x.id===id);
    if(!r||!e||e.status!=='reserved'||e.tokenId||e.basisUsd)throw Error('Entry rollback is not a pending reservation');
    if(!Number.isFinite(proof.basisUsd)||proof.basisUsd<=0||!Number.isFinite(proof.realizedNetUsd)||!Number.isSafeInteger(proof.blockNumber)||proof.blockNumber<=0||!proof.receiptHashes.length||proof.receiptHashes.some(h=>!/^0x[0-9a-f]{64}$/i.test(h)))throw Error('Invalid entry rollback proof');
    Object.assign(e,{status:'closed',basisUsd:proof.basisUsd,realizedNetUsd:proof.realizedNetUsd,closedAt:this.now(),closeReason:'ENTRY_ABORT',entryRollbackEvidence:proof});
    this.setPause(r,'Entry eligibility expired; funding rolled back, awaiting fresh health checks','data');this.save(s);this.sessionLossCheck();
  }
  reconcileNeverBroadcast(id:string,input:z.infer<typeof noBroadcastSchema>):void {
    const proof=noBroadcastSchema.parse(input);
    if(this.now()<proof.observedAt||this.now()-proof.observedAt>60_000)throw new Error('Reconciliation proof stale');
    const s=this.read(),r=s.session,e=r?.entries.find(x=>x.id===id);
    if(!r||!r.paused||!e||!['reserved','uncertain'].includes(e.status)||e.tokenId||e.basisUsd||e.closeReason)
      throw new Error('Only an unresolved never-broadcast entry can be reconciled');
    if('kind' in proof&&(proof.beforeObservedAt>=e.at||proof.observedAt<e.at))throw new Error('Nonce evidence does not bracket the attempt');
    e.status='aborted';e.noBroadcastEvidence=proof;
    this.setPause(r,'Never-broadcast attempt reconciled; entries remain paused','manual');this.save(s);
  }
  openPositions():Array<Entry & {tokenId:string;basisUsd:number}> {
    return (this.read().session?.entries??[]).filter((e):e is Entry & {tokenId:string;basisUsd:number}=>e.status!=='closed'&&!!e.tokenId&&!!e.basisUsd);
  }
  /** Operator only: verified receipt chain, no minted NFT, restored token baselines.
   * Records funding/rollback costs; never disguises a funded attempt as no-broadcast. */
  reconcileUnwoundEntry(id:string,input:z.infer<typeof entryUnwindSchema>):void {
    const proof=entryUnwindSchema.parse(input),s=this.read(),r=s.session,e=r?.entries.find(x=>x.id===id);
    if(!r||!r.paused||!e||e.status!=='uncertain'||e.tokenId||e.basisUsd||e.closeReason)throw Error('Entry is not an unresolved funding attempt');
    if(proof.observedAt>this.now()||this.now()-proof.observedAt>60000||proof.observedAt<e.at)throw Error('Stale unwind evidence');
    const basisUsd=Number(BigInt(proof.cashDebitWei))/1e18*proof.entryEthUsd;
    const realizedNetUsd=Number(BigInt(proof.cashReturnWei))/1e18*proof.exitEthUsd;
    positive.parse(basisUsd);z.number().finite().nonnegative().parse(realizedNetUsd);
    Object.assign(e,{status:'closed',basisUsd,realizedNetUsd,closeReason:'ENTRY_ABORT',closedAt:proof.observedAt,entryUnwindEvidence:proof});
    this.setPause(r,'Failed entry unwound; entries paused pending health checks','manual');this.save(s);this.sessionLossCheck();
  }
  /** Operator only: verify ownership, receipts, inventory and cleanup before calling.
   * Does not resume entries or reset the original holding clock. */
  reconcileMintedEntry(id:string,input:z.infer<typeof entryRecoverySchema>):void {
    const proof=entryRecoverySchema.parse(input),s=this.read(),r=s.session,e=r?.entries.find(x=>x.id===id);
    if(!r||!r.paused||r.lossTriggered||!e||e.status!=='uncertain'||e.tokenId||e.basisUsd||e.closeReason||r.entries.some(x=>x.tokenId===proof.tokenId))throw Error('Entry is not an unresolved mint');
    if(proof.observedAt>this.now()||this.now()-proof.observedAt>60000||proof.observedAt<e.at)throw Error('Stale recovery evidence');
    const basisUsd=Number(BigInt(proof.cashDebitWei))/1e18*proof.ethUsd;positive.parse(basisUsd);
    Object.assign(e,{status:'open',tokenId:proof.tokenId,basisUsd,entryRecoveryEvidence:proof});
    this.setPause(r,'Mint reconciled; entries paused pending fresh exit protection','manual');this.save(s);
  }
  evaluatePosition(tokenId:string,q:ExitSnapshot,settings:ExitSettings) {
    validateExitSettings(settings);
    const s=this.read(),e=s.session?.entries.find(x=>x.tokenId===tokenId);
    if(!e||!e.basisUsd||e.status!=='open')throw new Error('Position not open for evaluation');
    if(!Number.isFinite(q.netUsd)||q.netUsd<0||!Number.isSafeInteger(q.blockNumber)||q.blockNumber<0||
       !Number.isFinite(q.observedAt)||this.now()-q.observedAt>60_000||q.observedAt>this.now()+1000)throw new Error('Invalid or stale exit quote');
    if((e.blockNumber!=null&&q.blockNumber<e.blockNumber)||(e.markAt!=null&&q.observedAt<e.markAt))throw new Error('Regressing exit snapshot');
    const {netUsd,observedAt,blockNumber,...metrics}=q;
    if(Object.keys(metrics).length){
      if((q.tokenId!=null&&q.tokenId!==tokenId)||(e.observedPoolId&&q.poolId!=null&&q.poolId!==e.observedPoolId))throw new Error('Inconsistent exit identity');
      const parsed=valuationSchema.safeParse(metrics),v=parsed.success?parsed.data:undefined;
      if(v&&v.assets[0].address<v.assets[1].address&&v.expectedNetUsd+1e-8>=q.netUsd&&v.expectedNetUsd-q.netUsd<=v.slippageHaircutUsd+1e-8){
        e.observedPoolId=v.poolId;e.valuation=v;e.productivity=sampleProductivity(e.productivity,v,q.observedAt,this.runId);e.observationStatus='available';
      }else{e.valuation=undefined;e.observationStatus='invalid';if(e.productivity)e.productivity.runId='invalid-observation';}
    }else {e.valuation=undefined;e.observationStatus='unavailable';if(e.productivity)e.productivity.runId='missing-observation';}
    const pnlPct=(q.netUsd/e.basisUsd-1)*100;
    const ageMin=(this.now()-e.at)/60_000;
    if(ageMin<0)throw new Error('Position entry timestamp is in the future');
    e.peakPct=Math.max(e.peakPct??-Infinity,pnlPct);e.markUsd=q.netUsd;e.markAt=q.observedAt;e.blockNumber=q.blockNumber;
    if(settings.trailActivationPct>0 && e.peakPct+1e-8>=settings.trailActivationPct)e.armed=true;
    // Timers recycle unarmed positions; active trailing protection manages winners.
    const trailingActive=settings.trailActivationPct>0&&e.armed;
    if(!e.closeReason){
      if(settings.slPct>0&&pnlPct<=-settings.slPct+1e-8)e.closeReason='SL';
      else if(settings.trailActivationPct>0&&e.armed&&pnlPct<=e.peakPct-settings.trailGivebackPct+1e-8)e.closeReason='TRAIL';
      else if(settings.tpPct>0&&pnlPct+1e-8>=settings.tpPct)e.closeReason='TP';
      else if(!trailingActive&&(settings.maxHoldMin??0)>0&&ageMin>=settings.maxHoldMin!)e.closeReason='MAX_HOLD';
      else if(!trailingActive&&(settings.timedTpMin??0)>0&&ageMin>=settings.timedTpMin!&&pnlPct+1e-8>=settings.timedTpPct!)e.closeReason='TIME_TP';
    }
    this.save(s);return {pnlPct,peakPct:e.peakPct,reason:e.closeReason??null};
  }
  sessionLossCheck():boolean {
    const s=this.read(),r=s.session;if(!r)return false;
    if(r.lossTriggered)return true;
    let pnl=0;
    for(const e of r.entries){
      if(e.status==='aborted')continue; // zero cash movement; retained for audit
      if(!e.basisUsd||e.status==='uncertain'||e.status==='closing'||e.status==='reserved') {this.setPause(r,'Incomplete session valuation','uncertain');this.save(s);return false;}
      const value=e.status==='closed'?e.realizedNetUsd:e.markUsd;
      if(value==null||(e.status!=='closed'&&(!e.markAt||this.now()-e.markAt>60_000))){this.setPause(r,'Missing fresh session valuation',e.status==='closed'?'uncertain':'data');this.save(s);return false;}
      pnl+=value-e.basisUsd;
    }
    if(pnl<=-PILOT_LIMITS.lossUsd){
      r.lossTriggered=true;this.setPause(r,'Session loss limit reached','loss');
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
    e.status='open';this.setPause(s.session!,'Close preflight stopped before broadcast','uncertain');this.save(s);
  }
  finishClose(tokenId:string,netUsd:number):void {
    const s=this.read(),e=s.session?.entries.find(x=>x.tokenId===tokenId);
    if(!e||e.status!=='closing'||!Number.isFinite(netUsd))throw new Error('Invalid close settlement');
    e.status='closed';e.realizedNetUsd=netUsd;e.closedAt=this.now();this.save(s);this.sessionLossCheck();
  }
  failClose(tokenId:string):void {
    const s=this.read(),e=s.session?.entries.find(x=>x.tokenId===tokenId);if(!e)throw new Error('Unknown position');
    e.status='uncertain';this.setPause(s.session!,'Close outcome uncertain; reconcile before any retry','uncertain');this.save(s);
  }
}
export const riskStore=new RiskStore(dataPath('auto-risk.json'));
