import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as guard from '../src/radar/entry-guard.ts';

test('GMGN expiring during mint preflight blocks broadcast even while ETH reference is fresh',async()=>{
  let now=1000,sends=0,failed=0;
  class Clock extends Date {static now(){return now}}
  const cfg={autoLp:{enabled:true,entryPaused:false,sources:['hunt'],requireLlm:false,requireAction:'ape',minScore:75,maxOpen:3,maxTaxPct:5,minLiqUsd:1000,sizeUsd:30,mode:'inrange',slPct:10,tpPct:0,trailActivationPct:15,trailGivebackPct:5},scan:{minPoolLiqUsd:1000}};
  const session={paused:false,lossTriggered:false,entries:[]};
  const riskStore={entryAllowed:()=>true,openPositions:()=>[],snapshot:()=>session,reserveEntry:()=>{session.entries.push({id:'r',status:'reserved'});return'r'},failEntry:()=>{failed++},commitEntry:()=>{throw new Error('must not commit')}};
  const security={isHoneypot:false,buyTax:0,sellTax:0,currentLinkedHoldingRate:0,currentBundlerHoldingRate:0,observedAt:1000};
  class Contract {async getSlot0(){return{sqrtPriceX96:1n,tick:0,lpFee:30000}}async getLiquidity(){return 1n}}
  const deps={
    '../config.js':{cfg,C:{v4StateView:'0xstate'}},'../chain/txlock.js':{acquireWallet:()=>true,releaseWallet:()=>{}},'./oorcool.js':{inOorCooldown:()=>false},'../util/log.js':{logger:()=>({info(){}})},
    './gmgn.js':{gmgnToken:async()=>security},'./auto-risk.js':{riskStore,validateExitSettings:()=>{}},
    './entry-guard.js':{...guard,strictInventory:async()=>{},freshEntryPrice:async()=>{now=50000;return{usd:2000,observedAt:50000}},strictCashSnapshot:async()=>({eth:1,weth:0,usdg:0,blockNumber:1})},
    '../chain/candidate.js':{qualifyCandidate:async()=>({quote:'usd',liqUsd:2000,volPct:0,v4:{poolId:'pool',liquidity:1n}})},
    ethers:{ethers:{Contract}},'../chain/client.js':{provider:{}},'../chain/v4/abis.js':{STATEVIEW_ABI:[]},
    '../chain/v4/mint.js':{openV4UsdgInRange:async(_p,_a,opts)=>{now=71000;opts.strict.assertActive();sends++;throw new Error('unexpected financial broadcast')}},
  };
  const code=ts.transpileModule(readFileSync(new URL('../src/radar/autolp.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const api={};vm.runInNewContext(code,{exports:api,require(name){assert.ok(Object.hasOwn(deps,name),name);return deps[name]},Date:Clock});
  const result=await api.maybeAutoLp({token:'token',symbol:'TEST',source:'hunt'},null);
  assert.equal(sends,0);
  assert.equal(failed,1);
  assert.equal(result.opened,false);
  assert.match(result.reason,/GMGN observation stale/);
});
