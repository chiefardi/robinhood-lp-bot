import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
test('entries pause does not disable exits; uncertain close cannot be sent twice',async(t)=>{
  assert.ok(fs.existsSync(path.resolve('src/radar/risk-manager.ts')),'strict manager exists');
  const {runRiskCycle}=await import('../src/radar/risk-manager.ts');
  const {RiskStore}=await import('../src/radar/auto-risk.ts');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'risk-manager-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const now=Date.now();const s=new RiskStore(path.join(dir,'state.json'),()=>now);s.startSession();s.resumeEntries();
  s.commitEntry(s.reserveEntry({token:'a',sizeUsd:30,sizeEth:.01}),{tokenId:'1',basisUsd:30});s.pauseEntries();
  let calls=0,releases=0;
  const deps={quote:async()=>({netUsd:25,observedAt:now,blockNumber:1}),acquire:()=>true,release:()=>{releases++},
    settle:async()=>{calls++;throw Error('unknown receipt')},notify:()=>{},warn:()=>{}};
  const settings={tpPct:10,slPct:10,trailActivationPct:0,trailGivebackPct:5};
  await runRiskCycle(s,settings,deps);await runRiskCycle(s,settings,deps);
  assert.equal(calls,1);assert.equal(releases,2);assert.equal(s.openPositions()[0].status,'uncertain');
});

test('busy wallet skips the entire valuation cycle without pausing an active entry',async(t)=>{
  const {runRiskCycle}=await import('../src/radar/risk-manager.ts');const {RiskStore}=await import('../src/radar/auto-risk.ts');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'risk-busy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const s=new RiskStore(path.join(dir,'state.json'));s.startSession();s.resumeEntries();s.reserveEntry({token:'a',sizeUsd:30,sizeEth:.01});
  await runRiskCycle(s,{tpPct:10,slPct:10,trailActivationPct:0,trailGivebackPct:5},{quote:async()=>{throw Error('must not read')},acquire:()=>false,release:()=>assert.fail('not acquired'),settle:async()=>assert.fail('no send'),notify:()=>{},warn:()=>{}});
  assert.equal(s.snapshot().paused,false);
});
test('fresh quote failure sends no close; successful close records cash not trigger mark',async(t)=>{
  assert.ok(fs.existsSync(path.resolve('src/radar/risk-manager.ts')),'strict manager exists');
  const {runRiskCycle}=await import('../src/radar/risk-manager.ts');const {RiskStore}=await import('../src/radar/auto-risk.ts');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'risk-cash-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const now=Date.now();const s=new RiskStore(path.join(dir,'state.json'),()=>now);s.startSession();s.resumeEntries();
  s.commitEntry(s.reserveEntry({token:'a',sizeUsd:30,sizeEth:.01}),{tokenId:'1',basisUsd:30});
  let bad=true,calls=0,notice;
  const deps={quote:async()=>{if(bad)throw Error('RPC');return {netUsd:36,observedAt:now,blockNumber:1}},acquire:()=>true,release:()=>{},settle:async()=>{calls++;return 34},notify:x=>{notice=x},warn:()=>{}};
  const settings={tpPct:10,slPct:10,trailActivationPct:0,trailGivebackPct:5};
  await runRiskCycle(s,settings,deps);assert.equal(calls,0);assert.equal(s.entryAllowed(),false);
  bad=false;await runRiskCycle(s,settings,deps);assert.equal(calls,1);assert.equal(s.snapshot().entries[0].realizedNetUsd,34);assert.equal(notice.realizedPnlUsd,4);
});

test('notification failure cannot turn confirmed cash settlement into uncertain execution',async(t)=>{
  const {runRiskCycle}=await import('../src/radar/risk-manager.ts');const {RiskStore}=await import('../src/radar/auto-risk.ts');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'risk-notify-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const now=Date.now();const s=new RiskStore(path.join(dir,'state.json'),()=>now);s.startSession();s.resumeEntries();
  s.commitEntry(s.reserveEntry({token:'a',sizeUsd:30,sizeEth:.01}),{tokenId:'1',basisUsd:30});
  await runRiskCycle(s,{tpPct:10,slPct:10,trailActivationPct:0,trailGivebackPct:5},{quote:async()=>({netUsd:36,observedAt:now,blockNumber:1}),acquire:()=>true,release:()=>{},settle:async()=>34,notify:()=>{throw Error('Telegram down')},warn:()=>{}});
  assert.equal(s.snapshot().entries[0].status,'closed');
});

test('auto off while quoting prevents a new close intent or send',async(t)=>{
  const {runRiskCycle}=await import('../src/radar/risk-manager.ts');const {RiskStore}=await import('../src/radar/auto-risk.ts');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'risk-off-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const now=Date.now();const s=new RiskStore(path.join(dir,'state.json'),()=>now);s.startSession();s.resumeEntries();s.commitEntry(s.reserveEntry({token:'a',sizeUsd:30,sizeEth:.01}),{tokenId:'1',basisUsd:30});
  let enabled=true,calls=0;
  await runRiskCycle(s,{tpPct:10,slPct:10,trailActivationPct:0,trailGivebackPct:5},{quote:async()=>{enabled=false;return {netUsd:36,observedAt:now,blockNumber:1}},isEnabled:()=>enabled,acquire:()=>true,release:()=>{},settle:async()=>{calls++;return 34},notify:()=>{},warn:()=>{}});
  assert.equal(calls,0);assert.equal(s.openPositions()[0].status,'open');
});
