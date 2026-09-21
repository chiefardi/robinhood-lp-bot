import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import ts from 'typescript';import fs from 'node:fs';import {poolActivityFailure} from '../src/radar/entry-guard.ts';
for(const lag of [1000,61000])test(`qualification evaluates freshness after async discovery (${lag}ms), preserving observation time`,async()=>{
 let now=2000;class Clock extends Date{static now(){return now;}}
 const id='0x'+'a'.repeat(64),pool={poolId:id,fee:30000,quote:'usd',poolKey:{hooks:'0x'+'0'.repeat(40)}};
 const cfg={scan:{feeMinPpm:10000,feeMaxPpm:50000,minVolUsd:10000,minPoolLiqUsd:1000,maxVolLiqRatio:100,minPoolFeesUsd:1,minFeeYieldPct:0,minSpikeX:0}};
 const deps={'../config.js':{cfg},'./v4/discover.js':{discoverV4UsdgPools:async()=>{await Promise.resolve();now=2000+lag;return [pool];}},'./dexscreener.js':{dexPairs:async()=>new Map([[id,{vol24h:100000,liqUsd:50000,vol5m:2000,volH1:10000,buys5m:5,sells5m:5,observedAt:2000}]])},'../radar/entry-guard.js':{poolActivityFailure}};
 const code=ts.transpileModule(fs.readFileSync(new URL('../src/chain/candidate.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;const api={};vm.runInNewContext(code,{exports:api,require:n=>deps[n],Date:Clock});
 const result=await api.qualifyCandidate('token',undefined,'usd',{now:1000,minVol5m:1000,minVol1h:5000});
 if(lag>60000)assert.equal(result,null);else{assert.equal(result?.v4.poolId,id);assert.equal(result.observedAt,2000);}
});
