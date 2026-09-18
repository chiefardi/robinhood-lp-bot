import test from 'node:test';
import assert from 'node:assert/strict';
import * as guard from '../src/radar/entry-guard.ts';
import * as gmgn from '../src/radar/gmgn.ts';

const holderEvidence={status:'ok',observedAt:1000,rows:100,coverageRate:.9,unobservedRate:.1,custodyRate:.4,taggedRiskRate:.01,taggedRiskUpperRate:.11,largestWalletRate:.04,top10WalletRate:.4,largestSharedFunderRate:0};
const safe = { isHoneypot: false, buyTax: 0, sellTax: 0, holderEvidence, observedAt: 1000 };

test('entry telemetry exposes exact-pool and holder coverage numbers without holder addresses', () => {
  assert.equal(typeof guard.formatPoolActivityTelemetry, 'function');
  assert.equal(typeof guard.formatHolderTelemetry, 'function');
  assert.equal(guard.formatPoolActivityTelemetry({ vol5m: 900, volH1: 7000, buys5m: 1, sells5m: 2 }, { minVol5m: 1000, minVol1h: 5000 }),
    'pool m5=$900/$1000 h1=$7000/$5000 trades5m=1B/2S');
  assert.equal(guard.formatHolderTelemetry({ ...holderEvidence, coverageRate: .68, unobservedRate: .32, taggedRiskUpperRate: .34 }),
    'holders coverage=68% unseen=32% tagged-upper=34% rows=100');
  assert.equal(guard.formatHolderTelemetry(undefined), 'holders coverage=unknown');
});

test('raw GMGN booleans preserve false versus unknown and launch allocation never becomes current holdings',()=>{
  assert.equal(typeof gmgn.normalizeGmgnToken,'function');
  for(const value of [false,0,'0','false','no',' FALSE '])assert.equal(gmgn.normalizeGmgnToken({}, {is_honeypot:value},1000).isHoneypot,false);
  for(const value of [true,1,'1','true','yes'])assert.equal(gmgn.normalizeGmgnToken({}, {is_honeypot:value},1000).isHoneypot,true);
  for(const value of [null,undefined,'','unknown'])assert.equal(gmgn.normalizeGmgnToken({}, {is_honeypot:value},1000).isHoneypot,undefined);
  const data=gmgn.normalizeGmgnToken({}, {bundler_rate:'0',buy_tax:'',sell_tax:'bad',current_linked_holding_rate:'0.2'},1000);
  assert.equal(data.currentBundlerHoldingRate,undefined);
  assert.equal(data.launchBundlerRate,0);
  assert.equal(data.currentLinkedHoldingRate,0.2);
  assert.equal(data.buyTax,undefined);
  assert.equal(data.sellTax,undefined);
});

test('unknown security, launch-only bundles and stale observations cannot authorize entry', () => {
  assert.equal(typeof guard.securityFailure, 'function');
  assert.equal(guard.securityFailure(safe, 5, 1000), null);
  for (const data of [null, {}, {...safe,isHoneypot:undefined}, {...safe,buyTax:NaN}, {...safe,sellTax:Infinity}, {...safe,holderEvidence:undefined}, {...safe,holderEvidence:undefined,bundlerRate:0}, {...safe,observedAt:0}, {...safe,observedAt:2000}]) {
    assert.ok(guard.securityFailure(data, 5, 1000));
  }
  assert.ok(guard.securityFailure(safe, 5, 100_000));
  assert.ok(guard.securityFailure({...safe,holderEvidence:{...holderEvidence,taggedRiskUpperRate:.31}},5,1000));
});

test('basis counts native plus WETH and USDG debits including gas and refunds', () => {
  assert.equal(typeof guard.entryBasisUsd, 'function');
  assert.equal(guard.entryBasisUsd({eth:1,weth:1,usdg:20},{eth:0.989,weth:1,usdg:20},2000),22.00000000000002);
  assert.throws(()=>guard.entryBasisUsd({eth:1,weth:1,usdg:20},{eth:0.989,weth:1,usdg:25},2000),/USDG/);
  assert.throws(() => guard.entryBasisUsd({eth:1,weth:0,usdg:0},{eth:1,weth:0,usdg:0},2000));
  assert.throws(() => guard.entryBasisUsd({eth:1,weth:NaN,usdg:0},{eth:0,weth:0,usdg:0},2000));
});

test('wallet lock prevents two racing entries before either reads limits', async () => {
  assert.equal(typeof guard.guardedEntry, 'function');
  let busy=false, releaseMint;
  const events=[];
  const hold=new Promise(r=>releaseMint=r);
  const deps={acquire:()=>{if(busy)return false;busy=true;return true},release:()=>{busy=false},allowed:()=>true,prepare:async()=>{events.push('prepare');return {sizeEth:0.01}},reserve:()=>{events.push('reserve');return 'r1'},execute:async()=>{events.push('execute');await hold;return {tokenId:'1'}},commit:()=>events.push('commit'),fail:()=>events.push('fail')};
  const first=guard.guardedEntry(deps);
  await Promise.resolve();
  await assert.rejects(guard.guardedEntry(deps),/wallet busy/);
  assert.equal(busy,true);
  releaseMint();
  await first;
  assert.deepEqual(events,['prepare','reserve','execute','commit']);
  assert.equal(busy,false);
});

test('pause during awaited preflight prevents reservation or execution', async()=>{
  let allowed=true, executed=false;
  await assert.rejects(guard.guardedEntry({acquire:()=>true,release:()=>{},allowed:()=>allowed,prepare:async()=>{allowed=false;return {}},reserve:()=>{throw new Error('must not reserve')},execute:async()=>{executed=true},commit:()=>{},fail:()=>{}}),/paused/);
  assert.equal(executed,false);
});

test('partial mint and failed final accounting consume uncertain reservations',async()=>{
  for(const commitFails of [false,true]){
    const events=[];
    await assert.rejects(guard.guardedEntry({acquire:()=>true,release:()=>events.push('release'),allowed:()=>true,prepare:async()=>({}),reserve:()=>{events.push('reserve');return 'x'},execute:async()=>{events.push('mint');if(!commitFails)throw new Error('partial swap');return {}},commit:()=>{throw new Error('invalid basis')},fail:id=>events.push('uncertain:'+id)}));
    assert.deepEqual(events,['reserve','mint','uncertain:x','release']);
  }
});

test('inventory rejects incomplete enumeration and any missing owner or liquidity',()=>{
  assert.equal(typeof guard.assertInventory, 'function');
  const rows=[{tokenId:'7',owner:'0xabc',liquidity:1n}];
  assert.doesNotThrow(()=>guard.assertInventory('0xAbC',['7'],0n,1n,rows));
  for(const [v3,v4,rs] of [[1n,1n,rows],[0n,2n,rows],[0n,1n,[]],[0n,1n,[{...rows[0],owner:'0xdef'}]],[0n,1n,[{...rows[0],liquidity:0n}]]])assert.throws(()=>guard.assertInventory('0xabc',['7'],v3,v4,rs));
});

test('cash snapshot reads every asset at one block and propagates balance failures',async()=>{
  assert.equal(typeof guard.readCashSnapshot,'function');
  const read={block:async()=>({number:17,timestamp:Math.floor(Date.now()/1000),hash:'0x'+'a'.repeat(64)}),native:async block=>{assert.equal(block,17);return 10n**18n},weth:async block=>{assert.equal(block,17);return 2n*10n**18n},usdg:async block=>{assert.equal(block,17);return 3n*10n**6n},usdgDecimals:async()=>6};
  assert.deepEqual(await guard.readCashSnapshot(read),{eth:1,weth:2,usdg:3,blockNumber:17});
  await assert.rejects(guard.readCashSnapshot({...read,weth:async()=>{throw new Error('RPC failure')}}),/RPC failure/);
  await assert.rejects(guard.readCashSnapshot({...read,usdgDecimals:async()=>NaN}),/decimals/);
  await assert.rejects(guard.readCashSnapshot(read,18),/receipt/);
  for(const block of [null,{number:17,hash:'0x'+'a'.repeat(64)},{number:17,timestamp:Math.floor(Date.now()/1000)-120,hash:'0x'+'a'.repeat(64)},{number:17,timestamp:Math.floor(Date.now()/1000)+120,hash:'0x'+'a'.repeat(64)}])await assert.rejects(guard.readCashSnapshot({...read,block:async()=>block}),/block/);
  let reads=0;
  await assert.rejects(guard.readCashSnapshot({...read,block:async()=>({...await read.block(),hash:'0x'+(++reads===1?'a':'b').repeat(64)})}),/canonical/);
});

test('heuristic hunt scores cannot satisfy required real LLM gate',()=>{
  assert.equal(typeof guard.llmFailure,'function');
  const model={llm:{action:'ape',score:80,summary:'fixture'},llmSource:'model',gmgn:null};
  assert.equal(guard.llmFailure(model,true,'ape',75),null);
  assert.ok(guard.llmFailure({...model,llmSource:'heuristic'},true,'ape',75));
  assert.ok(guard.llmFailure({...model,llmSource:undefined},true,'ape',75));
  assert.ok(guard.llmFailure({...model,llm:{...model.llm,score:NaN}},true,'ape',75));
  assert.equal(guard.llmFailure(null,false,'ape',75),null);
});
