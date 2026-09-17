import test from 'node:test';
import assert from 'node:assert/strict';
import * as guard from '../src/radar/entry-guard.ts';
import {ethers} from 'ethers';

const usd='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const token='0x3333333333333333333333333333333333333333';
const key={currency0:usd,currency1:token,fee:30000,tickSpacing:600,hooks:ethers.ZeroAddress};
const id=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address','address','uint24','int24','address'],Object.values(key)));
const pool={poolKey:key,poolId:id,fee:30000,lpFee:30000,tickSpacing:600,liquidity:1000000n,sqrtPriceX96:2n**96n,tick:0,quote:'usd'};
const opts={fixedEntryPrice:2000,sizeUsd:30,expectedPoolId:id,priceObservedAt:1000,assertActive:()=>{}};

test('strict mint preflight rejects mismatched pool, oversized funds, stale or invalid reference before spending',()=>{
  assert.equal(typeof guard.validateEntryBudget,'function');
  assert.doesNotThrow(()=>guard.validateEntryBudget(pool,'0.015',opts,1000));
  for(const [p,amt,o] of [[{...pool,poolId:'0xbad'},'0.015',opts],[pool,'0.02',opts],[pool,'0.015',{...opts,fixedEntryPrice:0}],[pool,'0.015',{...opts,sizeUsd:31}],[pool,'0.015',{...opts,priceObservedAt:0}],[{...pool,poolKey:{...key,hooks:token}},'0.015',opts],[{...pool,liquidity:0n},'0.015',opts]])assert.throws(()=>guard.validateEntryBudget(p,amt,o,1000));
  assert.throws(()=>guard.validateEntryBudget(pool,'0.015',opts,62000));
});

test('strict token budget uses only acquired balance delta; stable side cannot consume entire wallet',()=>{
  assert.equal(typeof guard.strictMintAmounts,'function');
  assert.deepEqual(guard.strictMintAmounts({before0:1000000000n,before1:900719925474099300000n,after0:1015000000n,after1:900719925474114300000n,usdgIs0:true,usdgTarget:15000000n}),{amount0:15000000n,amount1:15000000n});
  assert.throws(()=>guard.strictMintAmounts({before0:0n,before1:10n,after0:15n,after1:9n,usdgIs0:true,usdgTarget:15n}));
});

test('strict pool state rejects unknown fee/tick and live static-fee mismatch',()=>{
  for(const p of [{...pool,lpFee:undefined},{...pool,lpFee:50000},{...pool,tick:NaN},{...pool,tick:Infinity}])assert.throws(()=>guard.validateEntryBudget(p,'0.015',opts,1000));
});
