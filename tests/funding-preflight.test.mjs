import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {ethers} from 'ethers';
const ROUTER='0x1111111111111111111111111111111111111111',TOKEN='0x3333333333333333333333333333333333333333',USER='0x2222222222222222222222222222222222222222',NATIVE='0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
function fixture(fault){
 const calls={simulated:0,built:0,signed:0};
 const deps={'ethers':{ethers},'../config.js':{env:{kyberBase:'https://fake.invalid',kyberChain:'robinhood',kyberRouter:fault==='missing'?'':ROUTER},cfg:{chainId:4663,lp:{slippagePct:1}}},'./client.js':{wallet:()=>({address:USER,sendTransaction:()=>{calls.signed++;throw Error('no signing')}}),provider:{getNetwork:async()=>({chainId:fault==='chain'?1n:4663n}),getCode:async()=>fault==='code'?'0x':'0x1234',call:async()=>{calls.simulated++;if(fault==='simulation')throw Error('simulation reverted');return '0x'},estimateGas:async()=>100n}},'../util/log.js':{logger:()=>({warn(){},info(){}})}};
 const fetch=async(url,opts)=>{
  if(opts?.method==='POST'){
   calls.built++;const {routeSummary:s}=JSON.parse(opts.body);
   return{ok:true,json:async()=>({code:0,data:{data:'0x1234',routerAddress:fault==='buildRouter'?'0x4444444444444444444444444444444444444444':ROUTER,transactionValue:s.tokenIn.toLowerCase()===NATIVE.toLowerCase()?s.amountIn:'0',amountIn:s.amountIn,amountOut:s.amountOut}})};
  }
  const u=new URL(url),tokenIn=u.searchParams.get('tokenIn'),tokenOut=u.searchParams.get('tokenOut'),amountIn=u.searchParams.get('amountIn');
  if(fault==='sell'&&tokenIn===TOKEN)return{ok:false,json:async()=>({code:1,message:'no sell route'})};
  return{ok:true,json:async()=>({code:0,data:{routerAddress:ROUTER,routeSummary:{tokenIn:fault==='currencies'?TOKEN:tokenIn,tokenOut,amountIn,amountOut:'10',route:[[{exchange:'fixture'}]]}}})};
 };
 const code=ts.transpileModule(readFileSync(new URL('../src/chain/kyber.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const api={};vm.runInNewContext(code,{exports:api,require:n=>deps[n],fetch,URL,AbortSignal,setTimeout,clearTimeout});return{api,calls};
}
test('funding preflight builds both routes and simulates native funding without signing',async()=>{
 const f=fixture();assert.equal(typeof f.api.preflightKyberFunding,'function');
 const result=await f.api.preflightKyberFunding(TOKEN,10n);
 assert.equal(result.amountOut,10n);assert.equal(f.calls.built,2);assert.equal(f.calls.simulated,1);assert.equal(f.calls.signed,0);
});
for(const fault of ['missing','chain','code','currencies','buildRouter','sell','simulation'])test(`funding readiness rejects ${fault} without signing`,async()=>{
 const f=fixture(fault);assert.equal(typeof f.api.preflightKyberFunding,'function');
 await assert.rejects(f.api.preflightKyberFunding(TOKEN,10n));assert.equal(f.calls.signed,0);
});
