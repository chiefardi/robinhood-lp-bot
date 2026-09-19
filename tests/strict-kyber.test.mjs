import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {ethers} from 'ethers';
const ROUTER='0x1111111111111111111111111111111111111111',TOKEN='0x3333333333333333333333333333333333333333',USER='0x2222222222222222222222222222222222222222',NATIVE='0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
function fixture(when){
 let paused=false;const calls={approve:0,send:0};
 class Contract{async allowance(){return 0n}async approve(){calls.approve++;return {hash:'a'}}async balanceOf(){return 1n}}
 const deps={'ethers':{ethers:{...ethers,Contract}},'../config.js':{env:{kyberBase:'https://fake.invalid',kyberChain:'robinhood',kyberRouter:ROUTER},cfg:{lp:{slippagePct:5}}},'./client.js':{wallet:()=>({address:USER,sendTransaction:async()=>{calls.send++;return{hash:'s'}}}),provider:{getBalance:async(_a,block)=>block===42?11n:1n,call:async()=>{if(when==='simulation')paused=true},estimateGas:async()=>100n},overrides:async()=>{if(when==='gas')paused=true;return{}},waitTx:async()=>({status:1,blockNumber:42})},'../util/log.js':{logger:()=>({warn(){},info(){}})}};
 const fetch=async(url,opts)=>{if(opts?.method==='POST'){if(when==='build')paused=true;return {ok:true,json:async()=>({code:0,data:{data:'0xabcd',routerAddress:ROUTER,transactionValue:when==='simulation'?'10':'0',amountIn:'10',amountOut:'10'}})}}const u=new URL(url);return{ok:true,json:async()=>({code:0,data:{routeSummary:{tokenIn:u.searchParams.get('tokenIn'),tokenOut:when==='wrongCurrency'?TOKEN:u.searchParams.get('tokenOut'),amountIn:'10',amountOut:'10',route:[[]]},routerAddress:ROUTER}})}};
 const code=ts.transpileModule(readFileSync(new URL('../src/chain/kyber.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const api={};vm.runInNewContext(code,{exports:api,require:n=>deps[n],fetch,URL,AbortSignal,setTimeout,clearTimeout});
 return{api,calls,strict:{assertActive(){if(paused)throw new Error('paused')}}};
}
for(const when of ['build','gas','simulation'])test(`strict swap honors pause after awaited ${when} before broadcast`,async()=>{
 const f=fixture(when);await assert.rejects(f.api.kyberSwap(when==='simulation'?NATIVE:TOKEN,NATIVE,10n,f.strict),/paused/);
 assert.equal(f.calls.approve,0);assert.equal(f.calls.send,0);
});

test('strict swap measures confirmed output at receipt block even if latest balance is cached',async()=>{
 const f=fixture('cached');const r=await f.api.kyberSwap(TOKEN,NATIVE,10n,f.strict);
 assert.equal(r.amountOut,10n);assert.equal(r.blockNumber,42);
});

test('actual fresh execution route cannot change currencies after readiness',async()=>{
 const f=fixture('wrongCurrency');await assert.rejects(f.api.kyberSwap(TOKEN,NATIVE,10n,f.strict),/identity/);
 assert.equal(f.calls.approve,0);assert.equal(f.calls.send,0);
});
