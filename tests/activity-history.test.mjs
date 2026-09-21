import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import * as hunt from '../src/radar/fast-hunt.ts';
const USDG='0x5fc5360d0400a0fd4f2af552add042d716f1d168',token='0x'+'a'.repeat(40),other='0x'+'b'.repeat(40),pool='0x'+'c'.repeat(64),spike='0x'+'d'.repeat(64);
const floors={minVolUsd:10000,minPoolFeesUsd:250,feeMaxPpm:50000,minPoolLiqUsd:50000,minVol5m:1000,minVol1h:5000};
const pair=(id,at,volume=2000,base=token)=>({pairAddr:id,version:'v4',baseTokenAddress:base,quoteTokenAddress:USDG,vol24h:30000,liqUsd:80000,vol5m:volume,volH1:10000,buys5m:3,sells5m:2,observedAt:at});
test('persistent exact pool beats unknown volume spike without rejecting new pools',t=>{
 assert.equal(typeof hunt.PoolActivityHistory,'function');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'activity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'history.json');
 let history=new hunt.PoolActivityHistory(file);const now=1800000000000;
 for(const offset of [-300000,-150000,0])history.record(pair(pool,now+offset),floors,now+offset);
 history=new hunt.PoolActivityHistory(file);
 const rows=[{token:{address:token}},{token:{address:other}}],pairs=new Map([[token,new Map([[pool,pair(pool,now)]])],[other,new Map([[spike,pair(spike,now,90000,other)]])]]);
 const ranked=hunt.rankExactPoolCandidates(rows,pairs,floors,now,history);assert.equal(ranked.length,2);assert.equal(ranked[0].result.token.address,token);assert.equal(ranked[0].activity.persistent,true);
 assert.deepEqual(hunt.rankHuntDispatch([{pool:{v4:{poolId:spike},vol5m:90000,activity:history.coverage(spike,now)}},{pool:{v4:{poolId:pool},vol5m:2000,activity:history.coverage(pool,now)}}]).map(x=>x.pool.v4.poolId),[pool,spike]);
});
test('duplicate stale invalid isolated and discontinuous samples cannot manufacture persistence',t=>{
 assert.equal(typeof hunt.PoolActivityHistory,'function');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'activity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'history.json'),h=new hunt.PoolActivityHistory(file),now=1800000000000;
 h.record(pair(pool,now),floors,now);h.record(pair(pool,now),floors,now);h.record(pair(pool,now-61000),floors,now);assert.equal(h.coverage(pool,now).observations,1);assert.equal(h.coverage(spike,now).persistent,false);
 h.record(pair(pool,now+400000),floors,now+400000);h.record(pair(pool,now+550000),floors,now+550000);assert.equal(h.coverage(pool,now+550000).persistent,false);assert.equal(h.coverage(pool,now+2400000).observations,0);
 fs.writeFileSync(file,'corrupt');assert.equal(new hunt.PoolActivityHistory(file).coverage(pool,now).persistent,false);
});
test('structurally valid but duplicate or unordered persisted samples fall back to unknown',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'history-corrupt-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'history.json'),now=1800000000000;
 for(const stamps of [[now-300000,now,now],[now,now-300000,now]]){
  fs.writeFileSync(file,JSON.stringify([{id:`4663:v4:${pool}`,currencies:[token,USDG].sort().join(':'),samples:stamps.map(at=>({at,eligible:true}))}]));
  assert.equal(new hunt.PoolActivityHistory(file).coverage(pool,now).observations,0);
 }
});
