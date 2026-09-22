import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {ethers} from 'ethers';
import * as guard from '../src/radar/entry-guard.ts';
import * as asymmetric from '../src/chain/v4/asymmetric.ts';
const USDG='0x5fc5360d0400a0fd4f2af552add042d716f1d168',TOKEN='0x6666666666666666666666666666666666666666';
const ID='0x'+'a'.repeat(64);

for(const failure of ['', 'token-route', 'cost', 'mode-change','refresh','rollback','rollback-stale'])test(`asymmetric auto entry ${failure||'success'} checks both legs and preserves exact mode`,async()=>{
 const cfg={autoLp:{enabled:true,entryPaused:false,sources:['hunt'],requireLlm:false,requireAction:'ape',minScore:75,maxOpen:3,maxTaxPct:5,minLiqUsd:1000,sizeUsd:29,mode:'asymmetric',slPct:10,tpPct:0,trailActivationPct:10,trailGivebackPct:5,exitCostBufferUsd:.25},scan:{minPoolLiqUsd:1000},watch:{minVol5m:1000,minVol1h:5000}};
 const session={paused:false,lossTriggered:false,entries:[]};let reserves=0,commits=0,snapshotCount=0,mints=0,rollbacks=0,failed=0,securityReads=0;const funding=[];
 const riskStore={entryAllowed:()=>true,openPositions:()=>[],snapshot:()=>session,reserveEntry:()=>{reserves++;session.entries.push({id:'r',status:'reserved'});return 'r'},failEntry:()=>{failed++;},commitEntry:()=>{commits++},commitEntryRollback:(_id,proof)=>{assert.equal(proof.blockNumber,42);assert(Math.abs(proof.basisUsd-30)<1e-8);assert(Math.abs(proof.realizedNetUsd-1)<1e-8);rollbacks++;}};
 const security={isHoneypot:false,buyTax:0,sellTax:0,observedAt:Date.now(),holderEvidence:{status:'ok',observedAt:Date.now(),rows:100,coverageRate:.9,unobservedRate:.1,custodyRate:.4,taggedRiskRate:0,taggedRiskUpperRate:.1,largestWalletRate:.04,top10WalletRate:.4,largestSharedFunderRate:0}};
 const pool={poolId:ID,liquidity:1n,tick:0,tickSpacing:10,sqrtPriceX96:2n**96n,poolKey:{currency0:USDG,currency1:TOKEN}};
 class Contract{async getSlot0(){return {sqrtPriceX96:2n**96n,tick:0,lpFee:30000}}async getLiquidity(){return 1n}}
 const deps={
  '../config.js':{cfg,C:{v4StateView:'state'}},'../chain/txlock.js':{acquireWallet:()=>true,releaseWallet:()=>{}},'./oorcool.js':{inOorCooldown:()=>false},'../util/log.js':{logger:()=>({info(){}})},
  './gmgn.js':{gmgnToken:async()=>{securityReads++;if(securityReads>1){security.observedAt=Date.now();security.holderEvidence.observedAt=Date.now();}return security;}},'./auto-risk.js':{riskStore,validateExitSettings:()=>{}},
  './entry-guard.js':{...guard,strictInventory:async()=>{},freshEntryPrice:async()=>({usd:2000,observedAt:Date.now()}),strictCashSnapshot:async()=>({eth:snapshotCount++?0.9855:1,weth:0,usdg:0,blockNumber:42})},
  '../chain/candidate.js':{qualifyCandidate:async()=>({quote:'usd',liqUsd:2000,volPct:0,vol5m:2000,volH1:8000,buys5m:10,sells5m:10,observedAt:Date.now(),v4:pool})},
  ethers:{ethers:{...ethers,Contract}},'../chain/client.js':{provider:{}},'../chain/v4/abis.js':{STATEVIEW_ABI:[]},'../chain/v4/discover.js':{USDG},
  '../chain/v4/asymmetric.js':asymmetric,
  '../chain/kyber.js':{assertKyberConfigured(){},preflightKyberFunding:async(token,n)=>{funding.push([token,n]);if(failure==='token-route'&&token===TOKEN)throw Error('token return route unavailable');return {amountOut:1n,returnWei:failure==='cost'?n*80n/100n:n,observedAt:Date.now()};}},
  '../chain/v4/mint.js':{openV4UsdgSingleSide:async()=>{throw Error('Wrong single-sided path')},openV4UsdgInRange:async(_pool,_amount,opts)=>{
   if(failure.startsWith('rollback')){if(failure==='rollback-stale')opts.strict.receiptObserved(43);throw new guard.EntryRolledBackError('activity stale',42,['0x'+'a'.repeat(64)],{eth:.985,weth:0,blockNumber:42});}
   if(failure==='refresh'){security.observedAt=Date.now()-61000;security.holderEvidence.observedAt=Date.now()-61000;opts.strict.fundingComplete();await opts.strict.refreshActive();opts.strict.assertActive();}
   assert.equal(opts.asymmetric,true);if(failure==='mode-change')cfg.autoLp.mode='single';opts.strict.assertActive();mints++;
   security.observedAt=Date.now()-61000;opts.strict.assertCleanupActive();assert.throws(()=>opts.strict.assertActive());
   cfg.autoLp.entryPaused=true;assert.throws(()=>opts.strict.assertCleanupActive(),/cleanup paused/);cfg.autoLp.entryPaused=false;
   return {tokenId:'1',poolId:ID,blockNumber:42,tickLower:-960,tickUpper:2240,mode:'asymmetric'};
  }},
 };
 const code=ts.transpileModule(readFileSync(new URL('../src/radar/autolp.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const api={};vm.runInNewContext(code,{exports:api,require(name){assert(Object.hasOwn(deps,name),name);return deps[name]},Date});
 const verdict={llm:{action:'ape',score:80,summary:'fixture'},llmSource:'heuristic',gmgn:null};
 const result=await api.maybeAutoLp({token:TOKEN,symbol:'TEST',source:'hunt',expectedPoolId:ID},verdict);
 assert.equal(funding.length,2,result.reason);const total=funding[0][1]+funding[1][1];assert(total>=14500000000000000n&&total<=14500000000000001n);
 const success=!failure||failure==='refresh';assert.equal(result.opened,success,result.reason);
 assert.equal(mints,success?1:0);assert.equal(commits,success?1:0);
 assert.equal(reserves,failure==='token-route'||failure==='cost'?0:1);
 if(failure==='mode-change')assert.match(result.reason,/mode changed/);
 if(failure==='refresh')assert(securityReads>1);
 if(failure==='rollback'){assert.equal(result.uncertain,false);assert.equal(failed,0);assert.equal(rollbacks,1);assert.match(result.reason,/funding returned/);}
 if(failure==='rollback-stale'){assert.equal(result.uncertain,true);assert.equal(failed,1);assert.equal(rollbacks,0);assert.match(result.reason,/Rollback cash inventory uncertain/);}
});
