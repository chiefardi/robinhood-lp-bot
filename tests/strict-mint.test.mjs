import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {ethers} from 'ethers';
import sdkCore from '@uniswap/sdk-core';
import sdkV4 from '@uniswap/v4-sdk';
import * as guard from '../src/radar/entry-guard.ts';
import * as asymmetric from '../src/chain/v4/asymmetric.ts';

const USDG='0x5fc5360d0400a0fd4f2af552add042d716f1d168', TOKEN='0x6666666666666666666666666666666666666666',USER='0x2222222222222222222222222222222222222222', POSM='0x1111111111111111111111111111111111111111';
const pk={currency0:USDG,currency1:TOKEN,fee:30000,tickSpacing:600,hooks:ethers.ZeroAddress};
const poolId=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address','address','uint24','int24','address'],Object.values(pk)));
const pool={poolKey:pk,poolId,fee:30000,tickSpacing:600,liquidity:10n**18n,sqrtPriceX96:2n**96n,tick:0,lpFee:30000,quote:'usd'};

function fixture(flag={},poolInput=pool) {
  const pool=poolInput;
  const TOKEN=(pool.poolKey.currency0.toLowerCase()===USDG?pool.poolKey.currency1:pool.poolKey.currency0).toLowerCase();
  const originalToken=1000000000n, originalUsd=1000000000n;
  const holdings=new Map([[TOKEN,originalToken],[USDG,originalUsd]]);
  const calls={sends:[],swaps:[],amounts:[],approved:[]};
  let position, minted=false;
  class Contract {
    constructor(address){this.address=address.toLowerCase();}
    async balanceOf(_owner,opts){if(flag.balanceFail)throw new Error('balance failure');if(flag.cachedAfterMint&&minted&&opts?.blockTag==null)return this.address===USDG?originalUsd:originalToken;return holdings.get(this.address)??0n;}
    async allowance(){return ethers.MaxUint256;}
    async approve(...args){calls.approved.push(args);return {hash:'0xapprove'};}
    async getSlot0(){if(flag.stateFail)throw new Error('state failure');return flag.moveAfterFunding?{sqrtPriceX96:BigInt(Math.floor(2**96*1.0001**300.25)),tick:600,lpFee:30000}:{sqrtPriceX96:pool.sqrtPriceX96,tick:0,lpFee:30000};}
    async getLiquidity(){return pool.liquidity;}
  }
  const P=sdkV4.Position;
  const Position={...P,fromAmounts(args){calls.amounts.push([BigInt(args.amount0),BigInt(args.amount1)]);position=P.fromAmounts(args);return position;},fromAmount0(args){position=P.fromAmount0(args);return position;},fromAmount1(args){position=P.fromAmount1(args);return position;}};
  const event=new ethers.Interface(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
  const encoded=event.encodeEventLog(event.getEvent('Transfer'),[ethers.ZeroAddress,USER,7n]);
  const receipt={status:1,blockNumber:42,logs:[{address:POSM,...encoded}]};
  const deps={
    ethers:{ethers:{...ethers,Contract}},'@uniswap/sdk-core':{default:sdkCore},'@uniswap/v4-sdk':{default:{...sdkV4,Position}},
    '../../config.js':{C:{v4PositionManager:POSM,v4StateView:POSM},cfg:{chainId:4663,lp:{widthPct:50}}},
    '../client.js':{provider:{getBalance:async()=>10n**18n,call:async()=>{}},wallet:()=>({address:USER,sendTransaction:async tx=>{calls.sends.push(tx);return {hash:'0xmint'};}}),overrides:async()=>({}),waitTx:async tx=>{
      if(tx.hash==='0xmint'){
        if(flag.waitFail)throw new Error('timeout');
        minted=true;
        holdings.set(pool.poolKey.currency0.toLowerCase(),holdings.get(pool.poolKey.currency0.toLowerCase())-BigInt(position.amount0.quotient.toString()));
        holdings.set(pool.poolKey.currency1.toLowerCase(),holdings.get(pool.poolKey.currency1.toLowerCase())-BigInt(position.amount1.quotient.toString()));
      }
      return receipt;
    }},
    '../tokens.js':{tokenMeta:async a=>({symbol:a.toLowerCase()===USDG?'USDG':'TEST',decimals:6})},
    './discover.js':{USDG},'./swap.js':{},
    '../kyber.js':{KYBER_NATIVE:ethers.ZeroAddress,kyberEnabled:()=>true,kyberSwap:async(input,output,amount)=>{
      calls.swaps.push({input,output,amount});
      if(minted && flag.sweepFail)throw new Error('sweep uncertain');
      if(input===ethers.ZeroAddress){const raw=amount*2000n*10n**6n/10n**18n;holdings.set(output.toLowerCase(),holdings.get(output.toLowerCase())+raw);return {tx:'0xswap',amountOut:raw,blockNumber:41};}
      holdings.set(input.toLowerCase(),holdings.get(input.toLowerCase())-amount);return {tx:'0xsweep',amountOut:1n,blockNumber:43};
    }},
    './poolkey.js':{NATIVE:ethers.ZeroAddress},'./abis.js':{STATEVIEW_ABI:[],V4_POSM_ABI:[]},'../blockscout.js':{},'../abis.js':{},
    '../price.js':{ethUsd:async()=>{throw new Error('strict must never read legacy price');}},
    '../../util/files.js':{dataPath:x=>x,readJson:()=>({}),writeJson:()=>{}},'../../util/log.js':{logger:()=>({info(){}})},
    '../../radar/entry-guard.js':guard,
    './asymmetric.js':asymmetric,
  };
  const source=readFileSync(new URL('../src/chain/v4/mint.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const api={};vm.runInNewContext(code,{exports:api,require(name){assert.ok(Object.hasOwn(deps,name),name);return deps[name];},setTimeout,clearTimeout});
  const strict={fixedEntryPrice:2000,sizeUsd:30,priceObservedAt:Date.now(),expectedPoolId:pool.poolId,assertActive:()=>{if(flag.paused)throw new Error('paused');}};
  return {api,calls,holdings,originalToken,originalUsd,strict};
}

test('asymmetric mint buys the tick-derived token share and reanchors -20/+10 after funding',async()=>{
 const f=fixture({moveAfterFunding:true});
 const r=await f.api.openV4UsdgInRange(pool,'0.015',{strict:f.strict,asymmetric:true});
 assert.equal(r.tickLower,-600);assert.equal(r.tickUpper,3000);
 const buys=f.calls.swaps.filter(s=>s.input===ethers.ZeroAddress);
 assert.equal(buys.length,2);
 assert(buys.find(s=>s.output.toLowerCase()===TOKEN).amount<7500000000000000n);
 assert.equal(buys.reduce((n,s)=>n+s.amount,0n),15000000000000000n);
 assert.equal(r.mode,'asymmetric');
 assert.equal(f.holdings.get(TOKEN),f.originalToken);
 assert.equal(f.holdings.get(USDG),f.originalUsd);
});

test('asymmetric mint also stays USDG-heavy when token is currency0',async()=>{
 const token='0x4444444444444444444444444444444444444444';
 const key={...pk,currency0:token,currency1:USDG};
 const reverse={...pool,poolKey:key,poolId:ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address','address','uint24','int24','address'],Object.values(key)))};
 const f=fixture({moveAfterFunding:true},reverse);
 const r=await f.api.openV4UsdgInRange(reverse,'0.015',{strict:f.strict,asymmetric:true});
 assert.equal(r.tickLower,-1800);assert.equal(r.tickUpper,1800);
 const buys=f.calls.swaps.filter(s=>s.input===ethers.ZeroAddress);
 assert(buys.find(s=>s.output.toLowerCase()===token).amount<7500000000000000n);
 assert.equal(f.holdings.get(token),f.originalToken);assert.equal(f.holdings.get(USDG),f.originalUsd);
});

test('strict inrange mint caps whole-wallet funds and leaves all preheld tokens untouched',async()=>{
  const f=fixture();await f.api.openV4UsdgInRange(pool,'0.015',{strict:f.strict,widthSpacings:8});
  assert.equal(f.holdings.get(TOKEN),f.originalToken);
  assert.equal(f.holdings.get(USDG),f.originalUsd);
  assert.equal(f.calls.sends.length,1);
  assert.ok(f.calls.amounts.every(([a,b])=>a<=30000000n&&b<=30000000n));
  assert.ok(f.calls.approved.every(args=>args[2]<=30000000n));
});

test('strict single-side uses fixed USD size rather than stale ETH cache',async()=>{
  const f=fixture();await f.api.openV4UsdgSingleSide(pool,'0.015',{strict:f.strict});
  assert.equal(f.holdings.get(TOKEN),f.originalToken);
  assert.equal(f.holdings.get(USDG),f.originalUsd);
  assert.ok(f.calls.swaps.some(s=>s.output.toLowerCase()===USDG));
});

for(const mode of ['openV4UsdgInRange','openV4UsdgSingleSide'])for(const flag of ['paused','balanceFail'])test(`${mode} blocks ${flag} before any spend`,async()=>{
  const f=fixture({[flag]:true});await assert.rejects(f.api[mode](pool,'0.015',{strict:f.strict}));
  assert.equal(f.calls.sends.length,0);assert.equal(f.calls.swaps.length,0);assert.equal(f.calls.approved.length,0);
});

test('strict inrange post-mint refund failure is propagated, never reported complete',async()=>{
  const f=fixture({sweepFail:true});await assert.rejects(f.api.openV4UsdgInRange(pool,'0.015',{strict:f.strict}),/sweep uncertain/);
  assert.equal(f.calls.sends.length,1);
});

for(const mode of ['openV4UsdgInRange','openV4UsdgSingleSide'])test(`${mode} returns final refund receipt block for pinned cash accounting`,async()=>{
  const f=fixture();const r=await f.api[mode](pool,'0.015',{strict:f.strict});
  assert.equal(r.blockNumber,43);
});

for(const mode of ['openV4UsdgInRange','openV4UsdgSingleSide'])test(`${mode} does not mistake cached premint balances for completed refunds`,async()=>{
  const f=fixture({cachedAfterMint:true});await f.api[mode](pool,'0.015',{strict:f.strict});
  assert.equal(f.holdings.get(USDG),f.originalUsd);assert.equal(f.holdings.get(TOKEN),f.originalToken);
});
