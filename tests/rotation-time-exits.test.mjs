import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RiskStore} from '../src/radar/auto-risk.ts';
import {runRiskCycle} from '../src/radar/risk-manager.ts';
import {riskAutoCommand} from '../src/telegram/auto-controls.ts';

const exits={tpPct:0,slPct:10,trailActivationPct:10,trailGivebackPct:5,timedTpMin:120,timedTpPct:5,maxHoldMin:360};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rotation-time-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let now=1_800_000_000_000;
 const file=path.join(dir,'state.json');const s=new RiskStore(file,()=>now);s.startSession();s.resumeEntries();
 const add=(token,id,basis=29)=>s.commitEntry(s.reserveEntry({token,sizeUsd:29,sizeEth:.01}),{tokenId:id,basisUsd:basis});
 const quote=value=>({netUsd:value,observedAt:now,blockNumber:Math.floor(now/1000)});
 return {s,file,add,quote,advance:ms=>{now+=ms},now:()=>now};
}

test('three concurrent positions block a fourth; confirmed settlement frees one slot without erasing history',t=>{
 const f=fixture(t),{s}=f;const id=s.snapshot().id;
 for(let i=1;i<=3;i++){f.add('token'+i,String(i));f.advance(3_600_001);}
 assert.equal(s.entryAllowed(),false);assert.throws(()=>s.reserveEntry({token:'four',sizeUsd:29,sizeEth:.01}));
 s.evaluatePosition('1',f.quote(25),exits);s.beginClose('1');
 assert.equal(s.entryAllowed(),false,'burn intent does not free slot');
 s.finishClose('1',27);
 for(const p of s.openPositions())s.evaluatePosition(p.tokenId,f.quote(29),{...exits,timedTpMin:0,maxHoldMin:0});
 s.resumeEntries();assert.equal(s.entryAllowed(),true,'settled historical entries no longer consume concurrency');
 f.add('four','4');assert.equal(s.openPositions().length,3);assert.equal(s.snapshot().entries.length,4);assert.equal(s.snapshot().id,id);
 assert.equal(s.snapshot().entries[0].realizedNetUsd,27);
});

test('outstanding cost basis caps exposure but unrealized profits do not force entry-cap sales',t=>{
 const f=fixture(t),{s}=f;f.add('a','1',31);f.advance(3_600_001);f.add('b','2',31);f.advance(3_600_001);
 assert.throws(()=>f.add('c','3'),/capital|exposure|budget/i,'31+31+29 exceeds $90');
 assert.equal(s.snapshot().entries.length,2);
 s.evaluatePosition('1',f.quote(100),{...exits,timedTpMin:0,maxHoldMin:0});
 assert.equal(s.entryAllowed(),true,'unrealized mark does not consume cost-basis exposure');
});

test('a token cannot occupy two slots, but can return after a confirmed exit',t=>{
 const f=fixture(t),{s}=f;f.add('same','1');f.advance(3_600_001);
 assert.throws(()=>f.add('SAME','2'),/Duplicate/);
 s.evaluatePosition('1',f.quote(25),exits);s.beginClose('1');s.finishClose('1',27);
 f.add('same','2');assert.equal(s.snapshot().entries.length,2);assert.equal(s.openPositions().length,1);
});

test('cumulative session losses survive replacement entries and latch at $15',t=>{
 const f=fixture(t),{s}=f;const session=s.snapshot().id;
 for(let i=1;i<=5;i++){
  f.add('t'+i,String(i));s.evaluatePosition(String(i),f.quote(26),exits);s.beginClose(String(i));s.finishClose(String(i),26);f.advance(3_600_001);
 }
 assert.equal(s.snapshot().id,session);assert.equal(s.snapshot().lossTriggered,true);assert.equal(s.entryAllowed(),false);
 assert.throws(()=>s.resumeEntries(),/loss/);assert.equal(s.snapshot().entries.length,5);
});

test('timed profit requires both 2h age and +5% fresh net return, persisted across restart',t=>{
 const f=fixture(t),{s}=f;f.add('a','1');f.advance(7_199_999);
 assert.equal(s.evaluatePosition('1',f.quote(31),exits).reason,null);
 f.advance(1);assert.equal(s.evaluatePosition('1',f.quote(30),exits).reason,null);
 const restarted=new RiskStore(f.file,f.now);
 assert.equal(restarted.evaluatePosition('1',f.quote(30.45),exits).reason,'TIME_TP');
});

test('six-hour expiry exits a losing position but cannot use stale quotes',t=>{
 const f=fixture(t),{s}=f;f.add('a','1');f.advance(21_599_999);
 assert.equal(s.evaluatePosition('1',f.quote(28),exits).reason,null);f.advance(1);
 assert.throws(()=>s.evaluatePosition('1',{...f.quote(28),observedAt:f.now()-61_000},exits),/stale/);
 assert.equal(s.openPositions()[0].closeReason,undefined);
 assert.equal(s.evaluatePosition('1',f.quote(28),exits).reason,'MAX_HOLD');
});

test('SL and trailing protection take priority over timed profit; existing old entries expire',t=>{
 const f=fixture(t),{s}=f;f.add('a','1');s.evaluatePosition('1',f.quote(34.8),exits);f.advance(21_600_000);
 assert.equal(s.evaluatePosition('1',f.quote(32.48),exits).reason,'TRAIL');
 const g=fixture(t);g.add('b','2');g.advance(21_600_000);
 assert.equal(g.s.evaluatePosition('2',g.quote(25),exits).reason,'SL');
 const h=fixture(t);h.add('c','3');h.advance(60_000_000);
 assert.equal(new RiskStore(h.file,h.now).evaluatePosition('3',h.quote(29),exits).reason,'MAX_HOLD');
});

test('a previously latched timed exit waits for a fresh quote after a no-broadcast retry',async t=>{
 const f=fixture(t),{s}=f;f.add('a','1');f.advance(21_600_000);
 let available=true,calls=0;
 const d={quote:async()=>{if(!available)throw Error('quote missing');return f.quote(28)},acquire:()=>true,release:()=>{},
  settle:async()=>{calls++;throw Object.assign(Error('preflight unavailable'),{broadcastPossible:false})},notify:()=>{},warn:()=>{}};
 await runRiskCycle(s,exits,d);assert.equal(calls,1);assert.equal(s.openPositions()[0].status,'open');
 available=false;f.advance(61_000);await runRiskCycle(s,exits,d);assert.equal(calls,1,'stale latched reason alone must not send');
});

test('operator status shows reusable slots and actual trailing and timed deadlines',async t=>{
 const f=fixture(t),{s}=f;f.add('a','1');s.evaluatePosition('1',f.quote(32.19),exits);
 const messages=[];const a={...exits,enabled:true,entryPaused:false,sizeUsd:29,compound:false,oorAction:'close',closeOor:false,volFadeX:0,minFeePerHourUsd:0,manageSec:30};
 await riskAutoCommand('status',a,{store:s,persist:()=>{},start:()=>{},stop:()=>{},send:async x=>messages.push(x),walletBusy:()=>false,checkFunding:async()=>{}});
 const text=messages.at(-1);assert.match(text,/1\/3.*(?:occupied|open)/i);assert.match(text,/2.*(?:free|available)/i);
 assert.match(text,/ARMED/);assert.match(text,/6\.00%/);assert.match(text,/TIME|Timed/);assert.match(text,/6h|360m/);
});

test('serial closes re-quote after an earlier settlement ages the next position valuation',async t=>{
 const f=fixture(t),{s}=f;f.add('a','1');f.advance(3_600_001);f.add('b','2');f.advance(21_600_000);
 const ages=[];let quotes=0;
 await runRiskCycle(s,exits,{quote:async()=>{quotes++;return f.quote(28)},acquire:()=>true,release:()=>{},
  settle:async id=>{const p=s.snapshot().entries.find(e=>e.tokenId===id);ages.push(f.now()-p.markAt);f.advance(61_000);return 28},notify:()=>{},warn:()=>{}});
 assert.deepEqual(ages,[0,0]);assert.equal(quotes,4);assert.equal(s.openPositions().length,0);
});

test('eligible distinct pools can fill three slots back-to-back, but unfinished entries and a fourth stay blocked',t=>{
 const f=fixture(t),{s}=f;
 const first=s.reserveEntry({token:'a',sizeUsd:29,sizeEth:.01});
 assert.equal(s.entryAllowed(29),false,'first workflow is still reserved');
 s.commitEntry(first,{tokenId:'1',basisUsd:29.15});
 assert.equal(s.entryAllowed(29),true,'no hourly delay after confirmed mint and accounting');
 f.add('b','2',29.15);assert.equal(s.entryAllowed(29),true);
 f.add('c','3',29.15);assert.equal(s.entryAllowed(29),false);
 assert.match(s.entryBlockReason(29),/slots/);
 assert.throws(()=>f.add('four','4'));
 assert.equal(s.snapshot().entries.length,3);assert.equal(new Set(s.snapshot().entries.map(e=>e.at)).size,1);
});

test('confirmed close frees capacity immediately in the same hour without waiving duplicate or dollar caps',t=>{
 const f=fixture(t),{s}=f;f.add('a','1');f.add('b','2');f.add('c','3');
 s.evaluatePosition('2',f.quote(29),exits);s.evaluatePosition('3',f.quote(29),exits);
 s.evaluatePosition('1',f.quote(25),exits);s.beginClose('1');assert.equal(s.entryAllowed(29),false);
 s.finishClose('1',27);assert.equal(s.entryAllowed(29),true);
 assert.throws(()=>f.add('b','4'),/Duplicate/);
 f.add('d','4');assert.equal(s.openPositions().length,3);assert.equal(s.snapshot().entries.length,4);
});

test('a winner first observed at either timer deadline arms trailing instead of taking a timed exit',t=>{
 for(const minutes of [120,360]){
  const f=fixture(t);f.add('a','1');f.advance(minutes*60_000);
  assert.equal(f.s.evaluatePosition('1',f.quote(36.25),exits).reason,null,'+25% winner must keep running');
  assert.equal(f.s.openPositions()[0].armed,true);
 }
});

test('armed winner ignores both timers across restart and exits only on peak giveback',t=>{
 const f=fixture(t);f.add('a','1');f.s.evaluatePosition('1',f.quote(31.9),exits);
 f.advance(120*60_000);const restarted=new RiskStore(f.file,f.now);
 assert.equal(restarted.evaluatePosition('1',f.quote(31.03),exits).reason,null,'+7% is below activation but above the +5% trailing floor');
 f.advance(240*60_000);assert.equal(restarted.evaluatePosition('1',f.quote(36.25),exits).reason,null);
 f.advance(60_000);assert.equal(restarted.evaluatePosition('1',f.quote(38.28),exits).reason,null,'+32% raises the floor to +27%');
 f.advance(60_000);assert.equal(restarted.evaluatePosition('1',f.quote(36.859),exits).reason,null);
 f.advance(60_000);assert.equal(restarted.evaluatePosition('1',f.quote(36.83),exits).reason,'TRAIL');
});

test('armed timer exemption never bypasses hard SL or cumulative session loss',t=>{
 const f=fixture(t);f.add('a','1');f.s.evaluatePosition('1',f.quote(36.25),exits);f.advance(360*60_000);
 assert.equal(f.s.evaluatePosition('1',f.quote(26.1),exits).reason,'SL');
 const g=fixture(t);g.add('a','1');g.add('b','2');g.add('c','3');
 g.s.evaluatePosition('1',g.quote(36.25),exits);g.advance(360*60_000);
 assert.equal(g.s.evaluatePosition('1',g.quote(36.25),exits).reason,null);
 g.s.evaluatePosition('2',g.quote(17),exits);g.s.evaluatePosition('3',g.quote(17),exits);
 assert.equal(g.s.sessionLossCheck(),true);
 assert.equal(g.s.openPositions().find(p=>p.tokenId==='1').closeReason,'SESSION');
});

test('disabling trailing restores timer eligibility despite a stored armed flag',t=>{
 const f=fixture(t);f.add('a','1');f.s.evaluatePosition('1',f.quote(36.25),exits);f.advance(360*60_000);
 assert.equal(f.s.evaluatePosition('1',f.quote(36.25),{...exits,trailActivationPct:0}).reason,'MAX_HOLD');
});

test('risk cycle retains an armed winner past expiry while settling an unarmed expired position',async t=>{
 const f=fixture(t);f.add('a','1');f.add('b','2');f.s.evaluatePosition('1',f.quote(36.25),exits);f.advance(360*60_000);
 const settled=[];
 await runRiskCycle(f.s,exits,{quote:async id=>f.quote(id==='1'?36.25:29),acquire:()=>true,release:()=>{},
  settle:async(id,reason)=>{settled.push({id,reason});return 29},notify:()=>{},warn:()=>{}});
 assert.deepEqual(settled,[{id:'2',reason:'MAX_HOLD'}]);
 assert.deepEqual(f.s.openPositions().map(p=>p.tokenId),['1']);
});
