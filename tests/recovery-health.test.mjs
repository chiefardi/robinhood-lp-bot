import test from 'node:test';import assert from 'node:assert/strict';
import * as health from '../src/radar/recovery-health.ts';
const now=1800000000000;
function fixture(){return {now:()=>now,settings:()=>({sizeUsd:29,slPct:10,tpPct:10,trailActivationPct:0,trailGivebackPct:5,compound:false,oorAction:'close',closeOor:false,volFadeX:0,minFeePerHourUsd:0}),trackedIds:['1'],
 nonces:async()=>({latest:4,pending:4}),inventory:async ids=>assert.deepEqual(ids,['1']),price:async()=>({usd:2000,observedAt:now-1000}),cash:async()=>({eth:.02,weth:0,usdg:0}),funding:async amount=>{assert.equal(amount,14500000000000001n);return {returnWei:14400000000000000n,observedAt:now-2000}}};}
test('recovery uses strict inventory and funding size, preserves oldest health timestamp',async()=>{
 assert.equal(typeof health.checkPilotRecoveryHealth,'function');assert.deepEqual(await health.checkPilotRecoveryHealth(fixture()),{observedAt:now-2000});
});
for(const fault of ['nonce','nonceChanged','inventory','gas','funds','funding','routeLoss','priceStale','routeStale','protection'])test(`recovery health rejects ${fault}`,async()=>{
 assert.equal(typeof health.checkPilotRecoveryHealth,'function');const d=fixture();
 if(fault==='nonce')d.nonces=async()=>({latest:4,pending:5});
 if(fault==='nonceChanged'){let call=0;d.nonces=async()=>{const n=++call===1?4:5;return {latest:n,pending:n}};}
 if(fault==='inventory')d.inventory=async()=>{throw Error('untracked NFT')};
 if(fault==='gas')d.cash=async()=>({eth:.0003,weth:.02,usdg:0});
 if(fault==='funds')d.cash=async()=>({eth:.01,weth:0,usdg:0});
 if(fault==='funding')d.funding=async()=>{throw Error('return route unavailable')};
 if(fault==='routeLoss')d.funding=async()=>({returnWei:1n,observedAt:now});
 if(fault==='priceStale')d.price=async()=>({usd:2000,observedAt:now-61000});
 if(fault==='routeStale')d.funding=async()=>({returnWei:14400000000000000n,observedAt:now-61000});
 if(fault==='protection'){const original=d.settings;d.settings=()=>({...original(),slPct:0});}
 await assert.rejects(health.checkPilotRecoveryHealth(d));
});
