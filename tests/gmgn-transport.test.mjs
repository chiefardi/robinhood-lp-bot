import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as holder from '../src/radar/holder-coverage.ts';
const address='0x'+'1'.repeat(40);
function harness(reply){
 let now=1000,active=0,maxActive=0;const calls=[];
 class Clock extends Date{static now(){return now}}
 const api={};
 const deps={'node:child_process':{execFile(bin,args,opts,cb){
   assert.equal(bin,'gmgn-cli');assert.ok(opts.timeout>0);
   if(args[0]==='config'){cb(null,'{}','');return;}
   active++;maxActive=Math.max(active,maxActive);calls.push({args,at:now});
   queueMicrotask(()=>{const r=reply(args,calls.length);now+=r.advance??0;active--;cb(r.error??null,JSON.stringify(r.body??{}),r.stderr??'')});
 }},'../util/log.js':{logger:()=>({info(){}})},'./holder-coverage.js':holder};
 const code=ts.transpileModule(readFileSync(new URL('../src/radar/gmgn.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{exports:api,require:n=>{assert.ok(deps[n],n);return deps[n]},Date:Clock,setTimeout:(fn,ms)=>{now+=ms;queueMicrotask(fn)}});
 return{api,calls,maxActive:()=>maxActive};
}
for(const nested of [false,true])test(`GMGN serializes and paces token requests and normalizes ${nested?'wrapped':'direct'} holders`,async()=>{
 const h=harness(args=>({body:args[1]==='info'?{symbol:'TEST'}:args[1]==='security'?{is_honeypot:false,buy_tax:'0',sell_tax:'0'}:(nested?{data:{list:[]}}:{list:[]})}));
 const a=await h.api.gmgnToken(address,{holders:true});
 assert.equal(a.isHoneypot,false);assert.equal(a.holderEvidence.status,'unknown');
 assert.equal(a.holderEvidence.reason,'holder list missing or invalid');
 assert.equal(h.maxActive(),1);assert.equal(h.calls.length,3);
 for(let i=1;i<h.calls.length;i++)assert.ok(h.calls[i].at-h.calls[i-1].at>=1500);
 assert.deepEqual(Array.from(h.calls[2].args),['token','holders','--chain','robinhood','--address',address,'--limit','100','--order-by','amount_percentage','--direction','desc','--raw']);
});
for(const cleanExit of [false,true])test(`rate limit ${cleanExit?'JSON envelope':'CLI error'} latches cooldown without retrying queued calls`,async()=>{
 const h=harness(()=>cleanExit?{body:{code:429,error:'RATE_LIMIT_EXCEEDED'}}:{error:new Error('CLI failed'),stderr:'RATE_LIMIT_EXCEEDED 429'});
 assert.equal(await h.api.gmgnToken(address),null);
 assert.equal(await h.api.gmgnToken(address),null);
 assert.equal(h.calls.length,1);
});
test('queued security requests older than thirty seconds are dropped, not refreshed to look current',async()=>{
 const h=harness(()=>({body:{symbol:'old'},advance:31000}));
 const g=await h.api.gmgnToken(address);
 assert.equal(h.calls.length,1);assert.equal(g.observedAt,1000);assert.equal(g.isHoneypot,undefined);
});
