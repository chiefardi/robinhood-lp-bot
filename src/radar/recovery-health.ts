/** Read-only wallet health; caller holds txlock. No signing or broadcast. */
import {RiskStore,validateExitSettings,type ExitSettings} from './auto-risk.js';
import {freshEntryPrice,strictCashSnapshot,strictInventory} from './entry-guard.js';
import {ethers} from 'ethers';
type Settings=ExitSettings&{sizeUsd:number;compound:boolean;oorAction:string;closeOor:boolean;volFadeX:number;minFeePerHourUsd:number};
interface HealthReads {
 now():number;settings():Settings;trackedIds:string[];
 nonces():Promise<{latest:number;pending:number}>;inventory(ids:string[]):Promise<void>;
 price():Promise<{usd:number;observedAt:number}>;cash():Promise<{eth:number;weth:number;usdg:number}>;
 funding(amount:bigint):Promise<{returnWei:bigint;observedAt:number}>;
}
export async function checkPilotRecoveryHealth(d:HealthReads):Promise<{observedAt:number}> {
 const a=d.settings();validateExitSettings(a);
 if(a.slPct<=0||(a.tpPct<=0&&a.trailActivationPct<=0)||a.compound||a.oorAction==='rebalance'||a.closeOor||a.volFadeX>0||a.minFeePerHourUsd>0)throw Error('Unsupported pilot exit configuration');
 const observedAt=d.now(),nonces=await d.nonces();
 if(!Number.isSafeInteger(nonces.latest)||nonces.latest<0||nonces.latest!==nonces.pending)throw Error('Pending or invalid wallet nonce');
 await d.inventory(d.trackedIds);
 const price=await d.price(),cash=await d.cash();
 if(!Number.isFinite(a.sizeUsd)||a.sizeUsd<=0||a.sizeUsd>30||!Number.isFinite(price.usd)||price.usd<=0)throw Error('Invalid entry funding inputs');
 const sizeEth=a.sizeUsd/price.usd;
 if(!Number.isFinite(sizeEth)||sizeEth<=0||[cash.eth,cash.weth,cash.usdg].some(n=>!Number.isFinite(n)||n<0)||cash.eth<0.0004||cash.eth+cash.weth-0.0004<sizeEth)throw Error('Insufficient entry funding/gas reserve');
 const amount=ethers.parseEther(sizeEth.toFixed(18)),funding=await d.funding(amount);
 const fundingLossPct=(1-Number(funding.returnWei)/Number(amount))*100;
 if(!Number.isFinite(fundingLossPct)||fundingLossPct>=a.slPct)throw Error('Funding round trip exceeds pilot stop-loss budget');
 const final=await d.nonces();
 if(final.latest!==nonces.latest||final.pending!==nonces.latest)throw Error('Wallet nonce changed during recovery');
 if([observedAt,price.observedAt,funding.observedAt].some(at=>!Number.isFinite(at)||at<=0||at>d.now()||d.now()-at>60000))throw Error('Stale recovery health');
 return {observedAt:Math.min(observedAt,price.observedAt,funding.observedAt)};
}
export async function pilotRecoveryHealth(store:RiskStore):Promise<{observedAt:number}> {
 const [{cfg},{provider,wallet},{preflightKyberFunding},{USDG}]=await Promise.all([
  import('../config.js'),import('../chain/client.js'),import('../chain/kyber.js'),import('../chain/v4/discover.js')]);
 const owner=wallet().address;
 return checkPilotRecoveryHealth({now:Date.now,settings:()=>cfg.autoLp,trackedIds:store.openPositions().map(p=>p.tokenId),
  nonces:async()=>{const [latest,pending]=await Promise.all([provider.getTransactionCount(owner,'latest'),provider.getTransactionCount(owner,'pending')]);return {latest,pending};},
  inventory:strictInventory,price:freshEntryPrice,cash:strictCashSnapshot,funding:amount=>preflightKyberFunding(USDG,amount)});
}
