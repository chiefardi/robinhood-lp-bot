import test from 'node:test';
import assert from 'node:assert/strict';

test('pnl and manual briefing commands render the same cash ledger without RPC or LLM fallback',async t=>{
 process.env.RH_TG_TOKEN='cash-test-token';process.env.RH_TG_CHAT='123456';
 const messages=[],oldFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  assert.ok(String(url).startsWith('https://api.telegram.org/botcash-test-token/'),'No RPC, explorer or LLM dependency permitted');
  const body=JSON.parse(options.body);messages.push(body.text);
  return new Response(JSON.stringify({ok:true,result:{message_id:1}}));
 };
 t.after(()=>{globalThis.fetch=oldFetch});
 const {riskStore}=await import('../src/radar/auto-risk.ts');
 const {onPnl,onBriefing}=await import('../src/telegram/handlers.ts');
 const original=riskStore.reportingSnapshot;
 const now=Date.now();
 riskStore.reportingSnapshot=()=>({version:1,history:[],session:{id:'test',startedAt:now-2000,paused:true,pauseReason:'Operator pause',lossTriggered:false,
  entries:[{id:'1',token:'0xabc',tokenId:'123',status:'closed',sizeUsd:29,sizeEth:.01,at:now-2000,closedAt:now-1000,basisUsd:29,realizedNetUsd:32,armed:false,closeReason:'MAX_HOLD'}]}});
 t.after(()=>{riskStore.reportingSnapshot=original});
 await onPnl();assert.match(messages.at(-1),/Current session realized:<\/b> \+\$3\.00/);
 await onBriefing();assert.match(messages.at(-1),/DAILY BRIEFING/);assert.match(messages.at(-1),/Current session realized:<\/b> \+\$3\.00/);
 assert.match(messages.at(-1),/PAUSED/);assert.match(messages.at(-1),/Fee breakdown: unavailable/);
 riskStore.reportingSnapshot=()=>{throw Error('Risk state invalid')};await onPnl();assert.match(messages.at(-1),/unavailable/);assert.doesNotMatch(messages.at(-1),/\$0\.00/);
});
