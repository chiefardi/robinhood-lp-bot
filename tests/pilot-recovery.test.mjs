import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {RiskStore} from '../src/radar/auto-risk.ts';
import {runRiskCycle} from '../src/radar/risk-manager.ts';
const settings={tpPct:10,slPct:10,trailActivationPct:0,trailGivebackPct:5};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let now=1800000000000;const file=path.join(dir,'risk.json');const store=new RiskStore(file,()=>now);store.startSession();store.resumeEntries();
 const d={now:()=>now,isEnabled:()=>true,entriesPaused:()=>false,quote:async()=>({netUsd:30,observedAt:now,blockNumber:1}),acquire:()=>true,release:()=>{},settle:async()=>assert.fail('no close'),notify:()=>{},warn:()=>{},recoveryHealth:async()=>({observedAt:now})};
 return {store,d,file,tick:async(ms=0)=>{now+=ms;await runRiskCycle(store,settings,d)},advance:ms=>now+=ms};
}
test('data failures never replace manual, initial or legacy pause permission',t=>{
 const f=fixture(t);assert.equal(typeof f.store.pauseDataEntries,'function');
 f.store.pauseEntries('Operator pause');const before=f.store.snapshot();f.store.pauseDataEntries('RPC unavailable');assert.deepEqual(f.store.snapshot(),before);
 const data=JSON.parse(fs.readFileSync(f.file));delete data.session.pauseKind;delete data.session.pauseRevision;fs.writeFileSync(f.file,JSON.stringify(data));
 f.store.pauseDataEntries('RPC unavailable');assert.equal(f.store.snapshot().pauseKind,undefined);
 f.store.resumeEntries();f.store.pauseDataEntries('RPC unavailable');assert.equal(f.store.snapshot().pauseKind,'data');
});
test('data recovery requires three spaced samples spanning sixty seconds',async t=>{
 const f=fixture(t);assert.equal(typeof f.store.pauseDataEntries,'function');f.store.pauseDataEntries('RPC');
 await f.tick();await f.tick(10000);await f.tick(10000);assert.equal(f.store.snapshot().paused,true);
 await f.tick(20000);assert.equal(f.store.snapshot().paused,true);await f.tick(20000);assert.equal(f.store.snapshot().paused,false);
});
test('operator pause during awaited health defeats same-session recovery',async t=>{
 const f=fixture(t);assert.equal(typeof f.store.pauseDataEntries,'function');f.store.pauseDataEntries('RPC');await f.tick();await f.tick(30000);
 f.d.recoveryHealth=async()=>{f.store.pauseEntries('Operator pause');return {observedAt:f.d.now()}};
 await f.tick(30000);assert.equal(f.store.snapshot().paused,true);assert.equal(f.store.snapshot().pauseKind,'manual');
});
for(const failure of ['health','quote','gap','restart','config','stale'])test(`${failure} cannot complete a recovery streak`,async t=>{
 const f=fixture(t);assert.equal(typeof f.store.pauseDataEntries,'function');
 f.store.commitEntry(f.store.reserveEntry({token:'a',sizeUsd:29,sizeEth:.01}),{tokenId:'1',basisUsd:30});f.store.pauseDataEntries('RPC');await f.tick();await f.tick(30000);
 if(failure==='health')f.d.recoveryHealth=async()=>{throw Error('inventory/nonce/funding unavailable')};
 if(failure==='quote')f.d.quote=async()=>{throw Error('missing quote')};
 if(failure==='config')f.d.entriesPaused=()=>true;
 if(failure==='stale')f.d.recoveryHealth=async()=>({observedAt:f.d.now()-61000});
 if(failure==='restart'){const restarted=new RiskStore(f.file,f.d.now);f.advance(30000);await runRiskCycle(restarted,settings,f.d);assert.equal(restarted.snapshot().paused,true);return;}
 await f.tick(failure==='gap'?91000:30000);assert.equal(f.store.snapshot().paused,true);
});
test('uncertain execution and latched exits are not recoverable',async t=>{
 const f=fixture(t);assert.equal(typeof f.store.pauseDataEntries,'function');const id=f.store.reserveEntry({token:'a',sizeUsd:29,sizeEth:.01});f.store.pauseDataEntries('RPC');f.store.failEntry(id);
 await f.tick();await f.tick(30000);await f.tick(30000);assert.equal(f.store.snapshot().paused,true);assert.notEqual(f.store.snapshot().pauseKind,'data');
});
test('recovery status does not expose external error URLs or credentials',async t=>{
 const f=fixture(t);f.store.pauseDataEntries('RPC');f.d.recoveryHealth=async()=>{throw Error('https://rpc.invalid/?api_key=SECRET')};await f.tick();assert.doesNotMatch(f.store.recoveryStatus(),/SECRET|https|api_key/);
});
test('valuation uncertainty cannot overwrite a pre-existing operator pause',t=>{
 const f=fixture(t),id=f.store.reserveEntry({token:'a',sizeUsd:29,sizeEth:.01});f.store.pauseEntries('Operator pause');const before=f.store.snapshot();f.store.failEntry(id);f.store.sessionLossCheck();
 assert.equal(f.store.snapshot().pauseKind,'manual');assert.equal(f.store.snapshot().pauseReason,'Operator pause');assert.equal(f.store.snapshot().pauseRevision,before.pauseRevision);
});
