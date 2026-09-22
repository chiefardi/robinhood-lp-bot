import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {poolActivityFailure} from '../src/radar/entry-guard.ts';
import {evaluateCandidatePools} from '../src/chain/candidate.ts';
import {PoolActivityHistory,rankExactPoolCandidates,rankHuntDispatch} from '../src/radar/fast-hunt.ts';
const now=1800000000000,token='0x'+'a'.repeat(40),usd='0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const steady='0x'+'b'.repeat(64),spike='0x'+'c'.repeat(64);
const limits={feeMinPpm:30000,feeMaxPpm:50000,minVolUsd:10000,minPoolFeesUsd:250,minPoolLiqUsd:50000,maxVolLiqRatio:20,minFeeYieldPct:0,minSpikeX:0,minVol5m:1000,minVol1h:5000};
const pool=id=>({poolId:id,fee:40000,quote:'usd',liquidity:1n,poolKey:{currency0:token,currency1:usd,fee:40000,tickSpacing:10,hooks:'0x'+'0'.repeat(40)},tickSpacing:10,sqrtPriceX96:1n,tick:0,lpFee:40000});
const pair=(id,at=now)=>({pairAddr:id,dexId:'uniswap',version:'v4',baseTokenAddress:token,quoteTokenAddress:usd,vol24h:id===steady?30000:100000,vol5m:id===steady?2000:9000,volH1:10000,liqUsd:80000,buys5m:3,sells5m:2,observedAt:at,chgH1:0,chgH6:0});
// Exercise the real async qualifier too; replace only provider discovery/data boundaries.
function qualifier(pools,dex){
 const deps={'../config.js':{cfg:{scan:limits}},'./v4/discover.js':{discoverV4Pools:async()=>[],discoverV4UsdgPools:async()=>pools},'./dexscreener.js':{dexPairs:async()=>dex},'../radar/entry-guard.js':{poolActivityFailure}};
 const code=ts.transpileModule(fs.readFileSync(new URL('../src/chain/candidate.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 class Clock extends Date{static now(){return now;}}
 const api={};vm.runInNewContext(code,{exports:api,require(name){assert.ok(Object.hasOwn(deps,name),name);return deps[name]},Date:Clock});return api.qualifyCandidate;
}
test('same-token persistent pool survives full qualification and final dispatch despite higher h24 spike fees',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qualification-history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const history=new PoolActivityHistory(path.join(dir,'history.json'));
 for(const offset of [-300000,-150000,0])history.record(pair(steady,now+offset),limits,now+offset);
 const dex=new Map([[steady,pair(steady)],[spike,pair(spike)]]);
 const ranked=rankExactPoolCandidates([{token:{address:token}}],new Map([[token,dex]]),limits,now,history);
 assert.equal(ranked[0].vol5m,2000);
 const activity={...limits,now,coverage:id=>history.coverage(id,now)};
 const qualified=await qualifier([pool(spike),pool(steady)],dex)(token,undefined,'usd',activity);
 assert.equal(qualified.v4.poolId,steady);
 assert.equal(qualified.activity.persistent,true);
 const unknown=evaluateCandidatePools([pool(spike)],dex,limits,'usd',activity).pool;
 assert.equal(unknown.v4.poolId,spike,'new pool remains eligible');
 assert.equal(rankHuntDispatch([{pool:unknown},{pool:qualified}])[0].pool.v4.poolId,steady);
 dex.set(steady,{...pair(steady),liqUsd:100});
 assert.equal(evaluateCandidatePools([pool(steady),pool(spike)],dex,limits,'usd',activity).pool.v4.poolId,spike,'history cannot bypass full liquidity gate');
});
test('fresh qualification preserves exact selected pool and never substitutes when it fails a gate',async()=>{
 const dex=new Map([[steady,pair(steady)],[spike,pair(spike)]]);
 const activity={...limits,now,expectedPoolId:steady};
 const qualify=qualifier([pool(spike),pool(steady)],dex);
 assert.equal((await qualify(token,undefined,'usd',activity)).v4.poolId,steady);
 dex.set(steady,{...pair(steady),vol5m:1});
 assert.equal(await qualify(token,undefined,'usd',activity),null);
 assert.equal(evaluateCandidatePools([pool(spike)],dex,limits,'usd',activity).pool,null);
});
test('equal history quality uses current exact-pool m5 volume without changing non-hunt fee ranking',()=>{
 const dex=new Map([[steady,{...pair(steady),vol5m:12000}],[spike,pair(spike)]]);
 const coverage=()=>({persistent:false,observations:0,spanSeconds:0,reason:'unknown'});
 assert.equal(evaluateCandidatePools([pool(spike),pool(steady)],dex,limits,'usd',{...limits,now,coverage}).pool.v4.poolId,steady);
 assert.equal(evaluateCandidatePools([pool(spike),pool(steady)],dex,limits,'usd').pool.v4.poolId,spike);
});
