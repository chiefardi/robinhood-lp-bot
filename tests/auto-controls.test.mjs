import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
test('English controls keep entry pause separate from stopping exits',async(t)=>{
  assert.ok(fs.existsSync(path.resolve('src/telegram/auto-controls.ts')),'risk controls required');
  const {riskAutoCommand}=await import('../src/telegram/auto-controls.ts');const {RiskStore}=await import('../src/radar/auto-risk.ts');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auto-controls-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const s=new RiskStore(path.join(dir,'risk.json'));const a={enabled:false,entryPaused:true,sizeUsd:30,tpPct:0,slPct:0,trailActivationPct:0,trailGivebackPct:5,compound:false,oorAction:'close',closeOor:false,volFadeX:0,minFeePerHourUsd:0,manageSec:90};
  let starts=0,stops=0;const messages=[];const d={store:s,persist:()=>{},start:()=>{starts++},stop:()=>{stops++},send:async m=>messages.push(m),walletBusy:()=>false,checkFunding:async()=>{}};
  await riskAutoCommand('session',a,d);assert.equal(a.enabled,false);assert.equal(s.entryAllowed(),false);
  await riskAutoCommand('trail 10 5',a,d);await riskAutoCommand('sl 10',a,d);await riskAutoCommand('on',a,d);
  assert.equal(starts,1);assert.equal(a.entryPaused,true);
  await riskAutoCommand('resume',a,{...d,checkFunding:async()=>{throw new Error('Funding unavailable')}});assert.equal(a.entryPaused,true);assert.equal(s.entryAllowed(),false);assert.match(messages.at(-1),/Funding unavailable/);
  await riskAutoCommand('resume',a,d);assert.equal(a.entryPaused,false);
  await riskAutoCommand('pause',a,d);assert.equal(a.enabled,true);assert.equal(stops,0);assert.equal(s.entryAllowed(),false);
  await riskAutoCommand('off',a,d);assert.equal(stops,1);assert.match(messages.at(-1),/exit monitoring are stopped/i);
  await riskAutoCommand('trail Infinity 5',a,d);assert.equal(a.trailActivationPct,10);assert.match(messages.at(-1),/Invalid/);
  await riskAutoCommand('status',a,d);assert.match(messages.at(-1),/cash basis/);assert.match(messages.at(-1),/3/);
});

test('changing protection pauses entries and cannot silently continue without a hard SL',async(t)=>{
  const {riskAutoCommand}=await import('../src/telegram/auto-controls.ts');const {RiskStore}=await import('../src/radar/auto-risk.ts');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auto-protection-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const s=new RiskStore(path.join(dir,'risk.json'));s.startSession();s.resumeEntries();
  const a={enabled:true,entryPaused:false,sizeUsd:30,tpPct:10,slPct:10,trailActivationPct:0,trailGivebackPct:5,compound:false,oorAction:'close',closeOor:false,volFadeX:0,minFeePerHourUsd:0,manageSec:90};
  const d={store:s,persist:()=>{},start:()=>{},stop:()=>{},send:async()=>{},walletBusy:()=>false,checkFunding:async()=>{}};
  await riskAutoCommand('sl 0',a,d);assert.equal(a.entryPaused,true);assert.equal(s.entryAllowed(),false);
  await riskAutoCommand('resume',a,d);assert.equal(a.entryPaused,true);
});
test('later operator pause defeats a resume awaiting funding in the same session',async t=>{
 const {riskAutoCommand}=await import('../src/telegram/auto-controls.ts');const {RiskStore}=await import('../src/radar/auto-risk.ts');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'resume-race-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const s=new RiskStore(path.join(dir,'risk.json'));s.startSession();
 const a={enabled:true,entryPaused:true,sizeUsd:29,tpPct:10,slPct:10,trailActivationPct:0,trailGivebackPct:5,compound:false,oorAction:'close',closeOor:false,volFadeX:0,minFeePerHourUsd:0,manageSec:90};
 const d={store:s,persist:()=>{},start:()=>{},stop:()=>{},send:async()=>{},walletBusy:()=>false,checkFunding:async()=>{await riskAutoCommand('pause',a,d)}};
 await riskAutoCommand('resume',a,d);assert.equal(s.snapshot().paused,true);assert.equal(a.entryPaused,true);
});
