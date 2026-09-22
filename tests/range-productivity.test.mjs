import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {RiskStore} from '../src/radar/auto-risk.ts';
import {buildCashReport} from '../src/radar/cash-report.ts';
import * as reports from '../src/radar/cash-report.ts';
const settings={tpPct:0,slPct:10,trailActivationPct:10,trailGivebackPct:5};
const asset=(feesRaw,address='0x'+'1'.repeat(40))=>({address,decimals:6,symbol:'USDG',principalRaw:'20000000',feesRaw});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'productivity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let now=1800000000000;const file=path.join(dir,'risk.json');let store=new RiskStore(file,()=>now);store.startSession();store.resumeEntries();store.commitEntry(store.reserveEntry({token:'a',sizeUsd:29,sizeEth:.01}),{tokenId:'1',basisUsd:30});
 const quote=(extra={})=>({tokenId:'1',poolId:'0x'+'a'.repeat(64),netUsd:30,expectedNetUsd:31,slippageHaircutUsd:1,gasReserveUsd:.25,inRange:true,assets:[asset('100'),asset('0','0x'+'2'.repeat(40))],observedAt:now,blockNumber:Math.floor(now/1000),...extra});
 return {get store(){return store},file,quote,sample(ms=0,extra={}){now+=ms;store.evaluatePosition('1',quote(extra),settings);return store.snapshot().entries[0]},restart(){store=new RiskStore(file,()=>now)}};
}
test('first fees are baseline; ordered sixty-second samples earn only their deltas',t=>{
 const f=fixture(t);let e=f.sample();assert.ok(e.productivity);assert.equal(e.productivity.observedSeconds,0);assert.equal(e.productivity.assets[0].accruedRaw,'0');
 e=f.sample(60000,{assets:[asset('160'),asset('0','0x'+'2'.repeat(40))]});assert.equal(e.productivity.observedSeconds,60);assert.equal(e.productivity.inRangeSeconds,60);assert.equal(e.productivity.assets[0].accruedRaw,'60');assert.equal(e.productivity.assets[1].accruedRaw,'0');
 const report=buildCashReport('pnl',f.store,f.quote().observedAt);assert.match(report,/expected.*\$31\.00/i);assert.match(report,/buffered.*\$30\.00/i);assert.match(report,/sampled/i);assert.match(report,/3600 raw units\/h/);
});
test('long gaps and restart downtime remain unknown, not active earning time',t=>{
 const f=fixture(t);f.sample();let e=f.sample(120000);assert.ok(e.productivity);assert.equal(e.productivity.observedSeconds,0);assert.equal(e.productivity.unknownSeconds,120);
 f.restart();e=f.sample(30000);assert.equal(e.productivity.unknownSeconds,150);assert.equal(e.productivity.observedSeconds,0);
 e=f.sample(60000,{inRange:false});assert.equal(e.productivity.observedSeconds,60);assert.equal(e.productivity.inRangeSeconds,0);
});
test('fee resets and currency changes reset baseline without negative earnings',t=>{
 const f=fixture(t);f.sample();let e=f.sample(60000,{assets:[asset('10'),asset('0','0x'+'2'.repeat(40))]});assert.ok(e.productivity);assert.equal(e.productivity.assets[0].accruedRaw,'0');assert.equal(e.productivity.assets[0].measuredSeconds,0);assert.match(e.productivity.assets[0].status,/reset/);
 e=f.sample(60000,{assets:[asset('30','0x'+'0'.repeat(40)),asset('0','0x'+'2'.repeat(40))]});assert.equal(e.productivity.assets[0].measuredSeconds,0);assert.equal(e.productivity.assets[0].address,'0x'+'0'.repeat(40));
});
test('wrong identities and regression cannot corrupt persisted marks',t=>{
 const f=fixture(t);f.sample();
 for(const extra of [{tokenId:'2'},{poolId:'0x'+'b'.repeat(64)},{observedAt:f.quote().observedAt-1}])assert.throws(()=>f.sample(0,extra));
 assert.equal(f.store.snapshot().entries[0].markUsd,30);
});
test('invalid additive diagnostics cannot disable a valid buffered stop loss',t=>{
 const f=fixture(t);f.sample();
 const e=f.sample(60000,{netUsd:26,expectedNetUsd:NaN});assert.equal(e.closeReason,'SL');assert.equal(e.markUsd,26);assert.equal(e.valuation,undefined);assert.equal(e.observationStatus,'invalid');
 const state=JSON.parse(fs.readFileSync(f.file));state.session.entries[0].productivity={garbage:true};fs.writeFileSync(f.file,JSON.stringify(state));
 assert.equal(f.store.snapshot().entries[0].markUsd,26);assert.equal(f.store.snapshot().entries[0].productivity,undefined);
});
test('large position diagnostics split into lossless Telegram-sized complete lines',t=>{
 const f=fixture(t);f.sample();const text=Array(8).fill(buildCashReport('pnl',f.store,f.quote().observedAt)).join('\n');
 assert.equal(typeof reports.reportChunks,'function');const chunks=reports.reportChunks(text);assert.ok(chunks.length>1);assert.ok(chunks.every(c=>c.length<=3900));assert.equal(chunks.join('\n'),text);
});
test('diagnostic gaps do not erase the pinned pool identity',t=>{
 const f=fixture(t);f.sample();f.sample(60000,{expectedNetUsd:NaN});assert.throws(()=>f.sample(60000,{poolId:'0x'+'b'.repeat(64)}),/identity/);
});
test('impossible persisted sampled counters degrade to unavailable',t=>{
 const f=fixture(t);f.sample();const state=JSON.parse(fs.readFileSync(f.file));state.session.entries[0].productivity.inRangeSeconds=100;fs.writeFileSync(f.file,JSON.stringify(state));
 assert.equal(f.store.snapshot().entries[0].productivity,undefined);
});
