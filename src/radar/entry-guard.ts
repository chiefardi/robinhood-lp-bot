// Hard auto-entry predicates and serialized reserve-before-send workflow.
import type { GmgnData } from './gmgn.js';
import type { Verdict } from './radar.js';
import type { V4Pool } from '../chain/v4/discover.js';
import { ethers } from 'ethers';
import {holderFailure, type HolderEvidence} from './holder-coverage.js';

export interface StrictEntryBudget {fixedEntryPrice:number;sizeUsd:number;expectedPoolId:string;priceObservedAt:number;assertActive():void}
export function validateEntryBudget(pool:V4Pool,amountEth:string,o:StrictEntryBudget,now=Date.now()):void {
  o.assertActive();
  const key=pool.poolKey;
  const id=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address','address','uint24','int24','address'],[key.currency0,key.currency1,key.fee,key.tickSpacing,key.hooks]));
  if (pool.quote !== 'usd' || ![key.currency0,key.currency1].some(a=>a.toLowerCase()==='0x5fc5360d0400a0fd4f2af552add042d716f1d168') || key.hooks !== ethers.ZeroAddress || id.toLowerCase()!==pool.poolId.toLowerCase() || id.toLowerCase()!==o.expectedPoolId.toLowerCase()) throw new Error('strict pool identity mismatch');
  if (pool.liquidity<=0n || pool.sqrtPriceX96<=0n || !Number.isInteger(pool.tick) || pool.lpFee!==key.fee || pool.fee!==key.fee || pool.tickSpacing!==key.tickSpacing || key.fee<30000 || key.fee>50000) throw new Error('invalid strict pool');
  if (!Number.isFinite(o.fixedEntryPrice) || o.fixedEntryPrice<=0 || !Number.isFinite(o.sizeUsd) || o.sizeUsd<=0 || o.sizeUsd>30 || !Number.isFinite(o.priceObservedAt) || o.priceObservedAt<=0 || now<o.priceObservedAt || now-o.priceObservedAt>60_000) throw new Error('invalid/stale entry budget');
  const wei=ethers.parseEther(amountEth);
  if (wei<=0n || Number(ethers.formatEther(wei))*o.fixedEntryPrice>o.sizeUsd+1e-8) throw new Error('entry exceeds reserved budget');
}

export function strictMintAmounts(x:{before0:bigint;before1:bigint;after0:bigint;after1:bigint;usdgIs0:boolean;usdgTarget:bigint}):{amount0:bigint;amount1:bigint} {
  const delta0=x.after0-x.before0,delta1=x.after1-x.before1;
  if (delta0<0n || delta1<0n || x.usdgTarget<=0n) throw new Error('entry balance delta invalid');
  const cap=(n:bigint)=>n<x.usdgTarget?n:x.usdgTarget;
  const result=x.usdgIs0?{amount0:cap(delta0),amount1:delta1}:{amount0:delta0,amount1:cap(delta1)};
  if (result.amount0<=0n || result.amount1<=0n) throw new Error('entry funding incomplete');
  return result;
}

export function llmFailure(verdict:Verdict|null,required:boolean,action:string,minScore:number):string|null {
  if (!required) return null;
  if (!verdict?.llm || verdict.llmSource !== 'model') return 'real LLM verdict required';
  const rank = (x:string) => x === 'ape' ? 2 : x === 'watch' ? 1 : x === 'skip' ? 0 : -1;
  if (!Number.isFinite(verdict.llm.score) || verdict.llm.score < minScore || verdict.llm.score > 100 || rank(verdict.llm.action)<rank(action)) return 'LLM threshold not met';
  return null;
}

export function heuristicScreenFailure(verdict:Verdict|null,minScore:number,requiredAction:string):string|null {
  if (!verdict?.llm || !['model','heuristic'].includes(verdict.llmSource??'')) return 'screen verdict missing';
  const rank = (x:string) => x === 'ape' ? 2 : x === 'watch' ? 1 : x === 'skip' ? 0 : -1;
  if (!Number.isFinite(verdict.llm.score) || verdict.llm.score < minScore || verdict.llm.score > 100 ||
      rank(verdict.llm.action) < rank(requiredAction)) return 'screen score/action below pilot threshold';
  return null;
}

export function activityLimits(source:string, watch:{minVol5m:number;minVol1h:number}, auto:{huntMinVol5m?:number;huntMinVol1h?:number}):{minVol5m:number;minVol1h:number} {
  return source === 'hunt'
    ? {minVol5m:auto.huntMinVol5m??watch.minVol5m,minVol1h:auto.huntMinVol1h??watch.minVol1h}
    : {minVol5m:watch.minVol5m,minVol1h:watch.minVol1h};
}

/** Numbers behind an activity rejection; observations only, never an alternate gate. */
export function formatPoolActivityTelemetry(p:{vol5m?:number;volH1?:number;buys5m?:number;sells5m?:number}, limits:{minVol5m:number;minVol1h:number}):string {
  const amount=(n:number|undefined)=>typeof n==='number'&&Number.isFinite(n)?`$${Math.round(n)}`:'unknown';
  const trades=(n:number|undefined)=>Number.isSafeInteger(n)?String(n):'unknown';
  return `pool m5=${amount(p.vol5m)}/${amount(limits.minVol5m)} h1=${amount(p.volH1)}/${amount(limits.minVol1h)} trades5m=${trades(p.buys5m)}B/${trades(p.sells5m)}S`;
}

/** Aggregate holder evidence only; no wallet identities or raw vendor payloads. */
export function formatHolderTelemetry(e:HolderEvidence|undefined):string {
  if(e?.status!=='ok'||![e.coverageRate,e.unobservedRate,e.taggedRiskUpperRate].every(n=>typeof n==='number'&&Number.isFinite(n)))return 'holders coverage=unknown';
  const pct=(n:number)=>`${Math.round(n*100)}%`;
  return `holders coverage=${pct(e.coverageRate!)} unseen=${pct(e.unobservedRate!)} tagged-upper=${pct(e.taggedRiskUpperRate!)} rows=${Number.isSafeInteger(e.rows)?e.rows:'unknown'}`;
}

export function poolActivityFailure(p:{vol5m?:number;volH1?:number;buys5m?:number;sells5m?:number;observedAt?:number},limits:{minVol5m:number;minVol1h:number},now:number):string|null {
  if(!Number.isFinite(now)||!Number.isFinite(p.observedAt)||p.observedAt!<=0||p.observedAt!>now||now-p.observedAt!>60_000)return 'exact pool activity stale or missing';
  if([p.vol5m,p.volH1,limits.minVol5m,limits.minVol1h].some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0))return 'exact pool volume missing or invalid';
  if(p.vol5m!<limits.minVol5m||p.volH1!<limits.minVol1h)return 'exact pool volume below pilot thresholds';
  if([p.buys5m,p.sells5m].some(n=>!Number.isSafeInteger(n)||n!<=0))return 'exact pool lacks recent two-way trades';
  return null;
}

export function securityFailure(g: GmgnData | null, maxTaxPct: number, now: number): string | null {
  if (!g) return 'fresh GMGN security required';
  if (!Number.isFinite(now) || !Number.isFinite(g.observedAt) || g.observedAt! <= 0 || now < g.observedAt! || now - g.observedAt! > 60_000) return 'GMGN observation stale or invalid';
  if (g.isHoneypot !== false) return 'honeypot not explicitly false';
  for (const tax of [g.buyTax, g.sellTax]) {
    if (typeof tax !== 'number' || !Number.isFinite(tax) || tax < 0 || tax > 1) return 'unknown or invalid tax';
    if (tax * 100 > maxTaxPct) return 'tax exceeds limit';
  }
  return holderFailure(g.holderEvidence,now);
}

export interface WalletSnapshot { eth: number; weth: number; usdg: number }
export async function freshEntryPrice(): Promise<{usd:number;observedAt:number}> {
  const {freshEthUsd} = await import('../chain/fresh-price.js');
  return freshEthUsd();
}

type CashBlock={number:number;timestamp:number;hash:string|null};
export async function readCashSnapshot(d:{block(height?:number):Promise<CashBlock|null>;native(block:number):Promise<bigint>;weth(block:number):Promise<bigint>;usdg(block:number):Promise<bigint>;usdgDecimals():Promise<number>},minBlock=0):Promise<WalletSnapshot & {blockNumber:number}> {
  const block = await d.block();
  const valid=(b:CashBlock|null)=>b&&Number.isSafeInteger(b.number)&&b.number>0&&Number.isFinite(b.timestamp)&&b.timestamp>0&&b.timestamp*1000<=Date.now()&&Date.now()-b.timestamp*1000<=60_000&&typeof b.hash==='string'&&/^0x[0-9a-f]{64}$/i.test(b.hash);
  if (!valid(block)) throw new Error('invalid, stale, or future snapshot block');
  const blockNumber=block!.number;
  if (!Number.isSafeInteger(minBlock)||minBlock<0||blockNumber<minBlock) throw new Error('snapshot predates financial receipt');
  const [eth,weth,usdg,decimals] = await Promise.all([d.native(blockNumber),d.weth(blockNumber),d.usdg(blockNumber),d.usdgDecimals()]);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('invalid USDG decimals');
  if ([eth,weth,usdg].some(v=>typeof v !== 'bigint' || v < 0n)) throw new Error('invalid raw balance');
  const snapshot = {eth:Number(eth)/1e18,weth:Number(weth)/1e18,usdg:Number(usdg)/10**decimals,blockNumber};
  if (Object.values(snapshot).some(v=>!Number.isFinite(v))) throw new Error('invalid wallet snapshot');
  const canonical=await d.block(blockNumber);
  if(!valid(canonical)||canonical!.hash!==block!.hash||canonical!.number!==blockNumber)throw new Error('snapshot block no longer canonical');
  return snapshot;
}

export async function strictCashSnapshot(minBlock=0):Promise<WalletSnapshot & {blockNumber:number}> {
  const {ethers} = await import('ethers');
  const {C} = await import('../config.js');
  const {provider,wallet} = await import('../chain/client.js');
  const {USDG} = await import('../chain/v4/discover.js');
  const {ERC20_ABI} = await import('../chain/abis.js');
  const owner = wallet().address;
  const weth = new ethers.Contract(C.weth,ERC20_ABI,provider);
  const usdg = new ethers.Contract(USDG,ERC20_ABI,provider);
  return readCashSnapshot({
    block:async height=>{
      if(height!=null)return provider.getBlock(height);
      const latest=await provider.getBlock('latest');
      return latest&&latest.number<minBlock?provider.getBlock(minBlock):latest;
    },
    native:block=>provider.getBalance(owner,block),
    weth:block=>weth.balanceOf!(owner,{blockTag:block}),
    usdg:block=>usdg.balanceOf!(owner,{blockTag:block}),
    usdgDecimals:async()=>Number(await usdg.decimals!()),
  },minBlock);
}

export async function strictInventory(trackedIds:string[]):Promise<void> {
  const {ethers} = await import('ethers');
  const {C} = await import('../config.js');
  const {provider,wallet} = await import('../chain/client.js');
  const {V4_POSM_ABI} = await import('../chain/v4/abis.js');
  if (!C.v4PositionManager || !C.positionManager) throw new Error('position manager unavailable');
  const owner = wallet().address;
  const blockTag = await provider.getBlockNumber();
  const v3 = new ethers.Contract(C.positionManager,['function balanceOf(address) view returns (uint256)'],provider);
  const v4 = new ethers.Contract(C.v4PositionManager,V4_POSM_ABI,provider);
  const [v3Balance,v4Balance,rows] = await Promise.all([
    v3.balanceOf!(owner,{blockTag}),v4.balanceOf!(owner,{blockTag}),
    Promise.all(trackedIds.map(async tokenId=>{
      const [nftOwner,liquidity] = await Promise.all([v4.ownerOf!(tokenId,{blockTag}),v4.getPositionLiquidity!(tokenId,{blockTag})]);
      return {tokenId,owner:String(nftOwner),liquidity:BigInt(liquidity)};
    })),
  ]);
  assertInventory(owner,trackedIds,BigInt(v3Balance),BigInt(v4Balance),rows);
}

export function entryBasisUsd(before: WalletSnapshot, after: WalletSnapshot, px: number): number {
  if (!Number.isFinite(px) || px <= 0 || [...Object.values(before), ...Object.values(after)].some(x => !Number.isFinite(x) || x < 0)) throw new Error('invalid wallet basis inputs');
  if(before.usdg!==after.usdg)throw new Error('USDG balance changed; peg-based basis prohibited');
  const basis = ((before.eth - after.eth) + (before.weth - after.weth)) * px;
  if (!Number.isFinite(basis) || basis <= 0) throw new Error('entry monetary basis uncertain');
  return basis;
}

export function assertInventory(owner: string, trackedIds: string[], v3Balance: bigint, v4Balance: bigint, rows: Array<{tokenId:string;owner:string;liquidity:bigint}>): void {
  if (v3Balance !== 0n) throw new Error('untracked v3 inventory');
  const ids = new Set(trackedIds);
  if (ids.size !== trackedIds.length || v4Balance !== BigInt(ids.size) || rows.length !== ids.size || new Set(rows.map(r=>r.tokenId)).size !== ids.size) throw new Error('v4 inventory cannot be reconciled');
  for (const row of rows) if (!ids.has(row.tokenId) || row.owner.toLowerCase() !== owner.toLowerCase() || typeof row.liquidity !== 'bigint' || row.liquidity <= 0n) throw new Error('tracked NFT owner/liquidity mismatch');
}

export async function guardedEntry<P, R>(d: {
  acquire():boolean; release():void; allowed():boolean; prepare():Promise<P>;
  reserve(prepared:P):string; execute(prepared:P):Promise<R>;
  commit(id:string,result:R,prepared:P):void; fail(id:string):void;
}): Promise<R> {
  if (!d.acquire()) throw new Error('wallet busy');
  let reservation: string | undefined;
  try {
    if (!d.allowed()) throw new Error('entries paused or session unavailable');
    const prepared = await d.prepare();
    if (!d.allowed()) throw new Error('entries paused during preflight');
    reservation = d.reserve(prepared);
    // No await between the final pause check, durable reservation and workflow start.
    const result = await d.execute(prepared);
    d.commit(reservation, result, prepared);
    return result;
  } catch (error) {
    if (reservation) d.fail(reservation);
    throw error;
  } finally {
    // Never Promise.race a financial workflow against a timeout here.
    d.release();
  }
}
