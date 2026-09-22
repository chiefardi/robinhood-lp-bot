import test from 'node:test';
import assert from 'node:assert/strict';

const api=await import('../src/chain/v4/asymmetric.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});

test('asymmetric range maps -20/+10 USDG/token bounds for both currency orders',()=>{
 assert.equal(typeof api.asymmetricRange,'function');
 for(const usdgIs0 of [false,true]){
  const r=api.asymmetricRange({sqrtPriceX96:2n**96n,tick:0,tickSpacing:10},usdgIs0);
  assert.deepEqual([r.tickLower,r.tickUpper],usdgIs0?[-960,2240]:[-2240,960]);
  const prices=[1.0001**r.tickLower,1.0001**r.tickUpper].map(p=>usdgIs0?1/p:p).sort((a,b)=>a-b);
  assert(prices[0]<=.8&&prices[0]>.799);
  assert(prices[1]>=1.1&&prices[1]<1.102);
  const tokenFraction=usdgIs0?r.fraction1:1-r.fraction1;
  assert(tokenFraction>.304&&tokenFraction<.308,'tick-derived allocation should be about 30.6% token, not 50/50');
 }
});

test('asymmetric ranges follow fractional current price and reject invalid pool state',()=>{
 assert.equal(typeof api.asymmetricRange,'function');
 const r=api.asymmetricRange({sqrtPriceX96:79238066158369533093537120256n,tick:2,tickSpacing:10},false);
 assert.equal(r.tickLower,-2230);assert.equal(r.tickUpper,960);
 for(const bad of [{sqrtPriceX96:0n,tick:0,tickSpacing:10},{sqrtPriceX96:2n**96n,tick:0,tickSpacing:0},{sqrtPriceX96:2n**96n,tick:100,tickSpacing:10}])assert.throws(()=>api.asymmetricRange(bad,false));
});

test('both funding legs and their exits must pass before the combined cost gate allows entry',async()=>{
 assert.equal(typeof api.preflightAsymmetricFunding,'function');
 const calls=[];
 const read=async(addr,amount)=>{calls.push([addr,amount]);return {amountOut:100n,returnWei:amount*98n/100n,observedAt:1000};};
 const p=await api.preflightAsymmetricFunding({sqrtPriceX96:2n**96n,tick:0,tickSpacing:10,poolKey:{currency0:'USDG',currency1:'TOKEN'}},'USDG',1000000n,read,10,29,.25);
 assert.equal(calls.length,2);
 assert.equal(calls[0][1]+calls[1][1],1000000n);
 assert(calls.find(([a])=>a==='TOKEN')[1]<320000n);
 assert.equal(p.observedAt,1000);
 await assert.rejects(api.preflightAsymmetricFunding({sqrtPriceX96:2n**96n,tick:0,tickSpacing:10,poolKey:{currency0:'USDG',currency1:'TOKEN'}},'USDG',1000000n,async()=>{throw Error('no return route');},10,29,.25),/no return route/);
 await assert.rejects(api.preflightAsymmetricFunding({sqrtPriceX96:2n**96n,tick:0,tickSpacing:10,poolKey:{currency0:'USDG',currency1:'TOKEN'}},'USDG',1000000n,async(_a,n)=>({amountOut:1n,returnWei:n*85n/100n,observedAt:1000}),10,29,.25),/stop-loss/);
});
