import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('persistent cash-basis trailing and session guard contract', async (t) => {
  const source = path.resolve('src/radar/auto-risk.ts');
  assert.ok(fs.existsSync(source), 'cash-basis risk store must exist');
  const { RiskStore } = await import('../src/radar/auto-risk.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-risk-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const file = path.join(dir, 'risk.json');
  const store = new RiskStore(file, () => now);
  assert.equal(store.entryAllowed(), false);
  store.startSession();
  assert.equal(store.entryAllowed(), false, 'new session remains paused');
  store.resumeEntries();
  const id = store.reserveEntry({token:'token1',sizeUsd:30,sizeEth:.01});
  store.commitEntry(id,{tokenId:'1',basisUsd:30});
  assert.equal(store.entryAllowed(), false, 'hourly cap');
  const settings = {tpPct:0,slPct:10,trailActivationPct:10,trailGivebackPct:5};
  const quote = (netUsd, blockNumber) => ({netUsd,blockNumber,observedAt:now});
  assert.equal(store.evaluatePosition('1',quote(32.7,1),settings).reason,null);
  assert.equal(store.evaluatePosition('1',quote(33,2),settings).reason,null);
  assert.equal(store.evaluatePosition('1',quote(37.5,3),settings).peakPct,25);
  const restarted = new RiskStore(file, () => now);
  assert.equal(restarted.evaluatePosition('1',quote(36,4),settings).reason,'TRAIL');
  assert.equal(restarted.openPositions()[0].peakPct,25);
  restarted.beginClose('1');
  const afterCrash = new RiskStore(file, () => now);
  assert.equal(afterCrash.entryAllowed(),false,'in-flight close blocks entries after restart');
  assert.equal(afterCrash.openPositions()[0].status,'closing');
  afterCrash.finishClose('1',35);
  now += 3_600_001;
  afterCrash.resumeEntries();
  for (let n=2;n<=3;n++) {
    const r=afterCrash.reserveEntry({token:`token${n}`,sizeUsd:30,sizeEth:.01});
    afterCrash.commitEntry(r,{tokenId:String(n),basisUsd:30});
    if(n===2) now+=3_600_001;
  }
  assert.equal(afterCrash.entryAllowed(),false,'closed capital does not reset total entry cap');
  assert.throws(()=>afterCrash.startSession(),/unresolved/);
});

test('stale/invalid marks never arm TP and loss is versus fixed cash basis', async(t)=>{
  assert.ok(fs.existsSync(path.resolve('src/radar/auto-risk.ts')),'risk store required');
  const {RiskStore}=await import('../src/radar/auto-risk.ts');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'risk-invalid-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let now=1_800_000_000_000;
  const s=new RiskStore(path.join(dir,'state.json'),()=>now);
  s.startSession();s.resumeEntries();
  s.commitEntry(s.reserveEntry({token:'a',sizeUsd:30,sizeEth:.01}),{tokenId:'9',basisUsd:30});
  const settings={tpPct:10,slPct:10,trailActivationPct:0,trailGivebackPct:5};
  assert.throws(()=>s.evaluatePosition('9',{netUsd:100,observedAt:now-61000,blockNumber:1},settings),/stale/);
  assert.equal(s.openPositions()[0].peakPct,undefined);
  const r=s.evaluatePosition('9',{netUsd:22,observedAt:now,blockNumber:2},settings);
  assert.equal(r.reason,'SL');assert.ok(Math.abs(r.pnlPct+26.6666666667)<1e-8);
  s.failClose('9');
  assert.equal(new RiskStore(path.join(dir,'state.json'),()=>now).entryAllowed(),false);
  assert.throws(()=>s.resumeEntries(),/uncertain/);
  fs.writeFileSync(path.join(dir,'state.json'),'{broken');
  assert.equal(s.entryAllowed(),false);
  assert.throws(()=>s.startSession(),/state/);
});

test('session loss circuit and reservation survive restarts',async(t)=>{
  assert.ok(fs.existsSync(path.resolve('src/radar/auto-risk.ts')),'risk store required');
  const {RiskStore}=await import('../src/radar/auto-risk.ts');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'risk-loss-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let now=1_800_000_000_000;const file=path.join(dir,'state.json');
  const s=new RiskStore(file,()=>now);s.startSession();s.resumeEntries();
  const id=s.reserveEntry({token:'a',sizeUsd:30,sizeEth:.01});
  assert.equal(new RiskStore(file,()=>now).entryAllowed(),false);
  s.commitEntry(id,{tokenId:'7',basisUsd:30});
  s.evaluatePosition('7',{netUsd:14,observedAt:now,blockNumber:1},{tpPct:0,slPct:0,trailActivationPct:0,trailGivebackPct:5});
  assert.equal(s.sessionLossCheck(),true);
  assert.equal(s.openPositions()[0].closeReason,'SESSION');
  assert.equal(s.entryAllowed(),false);
  assert.throws(()=>s.resumeEntries(),/loss/);
});
