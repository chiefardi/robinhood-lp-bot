import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RiskStore} from '../src/radar/auto-risk.ts';

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cash-report-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let now=1_800_000_000_000;const file=path.join(dir,'state.json'),store=new RiskStore(file,()=>now);
 store.startSession();store.resumeEntries();
 const add=id=>store.commitEntry(store.reserveEntry({token:id,sizeUsd:29,sizeEth:.01}),{tokenId:id,basisUsd:29});
 const close=(id,net)=>{store.evaluatePosition(id,{netUsd:25,observedAt:now,blockNumber:1},{tpPct:0,slPct:10,trailActivationPct:10,trailGivebackPct:5});store.beginClose(id);store.finishClose(id,net)};
 return {store,file,add,close,now:()=>now,advance:ms=>{now+=ms}};
}
test('cash settlement records close time and history report survives session rotation',async t=>{
 const f=fixture(t);f.add('1');f.advance(1000);f.close('1',32);
 assert.equal(f.store.snapshot().entries[0].closedAt,f.now());
 f.store.startSession();f.store.resumeEntries();f.add('2');f.close('2',28);
 const {summarizeCash}=await import('../src/radar/cash-report.ts');
 const r=summarizeCash(f.store.reportingSnapshot(),f.now());
 assert.equal(r.lifetime.pnlUsd,2);assert.equal(r.lifetime.count,2);assert.equal(r.lifetime.wins,1);assert.equal(r.lifetime.losses,1);
 assert.equal(r.session.pnlUsd,-1);assert.equal(r.day.pnlUsd,2);
});
test('unknown close times and stale marks are unavailable rather than fabricated zeroes',async t=>{
 const f=fixture(t);f.add('1');f.close('1',32);
 const raw=JSON.parse(fs.readFileSync(f.file,'utf8'));delete raw.session.entries[0].closedAt;fs.writeFileSync(f.file,JSON.stringify(raw));
 f.add('2');f.store.evaluatePosition('2',{netUsd:30,observedAt:f.now(),blockNumber:1},{tpPct:0,slPct:10,trailActivationPct:10,trailGivebackPct:5});f.advance(61_000);
 const {summarizeCash,renderCashReport}=await import('../src/radar/cash-report.ts');const r=summarizeCash(f.store.reportingSnapshot(),f.now());
 assert.equal(r.lifetime.pnlUsd,3);assert.equal(r.day.pnlUsd,null);assert.equal(r.undated,1);
 assert.equal(r.open.valueUsd,null);assert.equal(r.open.pnlUsd,null);assert.equal(r.open.count,1);
 const text=renderCashReport(r,'briefing');assert.match(text,/unavailable/i);assert.match(text,/Fee breakdown: unavailable/);assert.doesNotMatch(text,/fee.*\$0\.00/i);
});
test('24h uses settlement time, excludes aborts and keeps flat separate from losses',async t=>{
 const f=fixture(t);f.add('1');f.close('1',29);f.advance(86_400_001);f.add('2');f.close('2',31);
 const {summarizeCash}=await import('../src/radar/cash-report.ts');const state=f.store.reportingSnapshot();
 // Independent reporting fixture includes an aborted no-spend record, never a trade.
 state.session.entries.push({...state.session.entries[0],id:'aborted',tokenId:undefined,status:'aborted',basisUsd:undefined,realizedNetUsd:undefined});
 const r=summarizeCash(state,f.now());assert.equal(r.day.pnlUsd,2);assert.equal(r.day.count,1);
 assert.equal(r.lifetime.count,2);assert.equal(r.lifetime.flat,1);assert.equal(r.lifetime.losses,0);
});
test('malformed risk state fails closed instead of reporting an empty account',t=>{
 const f=fixture(t);fs.writeFileSync(f.file,'broken');assert.throws(()=>f.store.reportingSnapshot(),/Risk state/);
});

test('verified timestamp backfill cannot rewrite cash amounts or overwrite a recorded close time',t=>{
 const f=fixture(t);f.add('1');f.close('1',32);const raw=JSON.parse(fs.readFileSync(f.file,'utf8'));
 delete raw.session.entries[0].closedAt;fs.writeFileSync(f.file,JSON.stringify(raw));
 const evidence={closedAt:f.now(),txHash:'0x'+'a'.repeat(64),blockNumber:2};
 assert.throws(()=>f.store.backfillCloseTime('1',{...evidence,closedAt:f.now()+1}),/timestamp/);
 f.store.backfillCloseTime('1',evidence);assert.equal(f.store.snapshot().entries[0].closedAt,f.now());
 assert.equal(f.store.snapshot().entries[0].basisUsd,29);assert.equal(f.store.snapshot().entries[0].realizedNetUsd,32);
 assert.throws(()=>f.store.backfillCloseTime('1',evidence),/already/);
});

test('missing or uninitialized cash ledger cannot masquerade as a zero account',async t=>{
 const f=fixture(t);const {buildCashReport}=await import('../src/radar/cash-report.ts');
 fs.unlinkSync(f.file);assert.throws(()=>buildCashReport('pnl',f.store),/unavailable|initialized/i);
 fs.writeFileSync(f.file,JSON.stringify({version:1,session:null,history:[]}));
 assert.throws(()=>buildCashReport('briefing',f.store),/unavailable|initialized/i);
});
