import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import ts from 'typescript';import fs from 'node:fs';import {ethers} from 'ethers';import sdkCore from '@uniswap/sdk-core';
for(const field of ['symbol','decimals'])test(`transient ${field} failure cannot permanently poison financial metadata`,async()=>{
 let failing=true,reads=0;class Contract{async symbol(){reads++;if(failing&&field==='symbol')throw Error('RPC unavailable');return 'USDG';}async decimals(){if(failing&&field==='decimals')throw Error('RPC unavailable');return 6;}async totalSupply(){return 1000000n;}}
 const deps={ethers:{ethers:{...ethers,Contract}},'@uniswap/sdk-core':{default:sdkCore},'../config.js':{cfg:{chainId:4663}},'./client.js':{provider:{}},'./abis.js':{ERC20_ABI:[]}};
 const code=ts.transpileModule(fs.readFileSync(new URL('../src/chain/tokens.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;const api={};vm.runInNewContext(code,{exports:api,require:n=>deps[n],setTimeout,clearTimeout});
 await assert.rejects(api.tokenMeta('0x'+'1'.repeat(40)));
 failing=false;const m=await api.tokenMeta('0x'+'1'.repeat(40));assert.equal(m.symbol,'USDG');assert.equal(m.decimals,6);const n=reads;await api.tokenMeta('0x'+'1'.repeat(40));assert.equal(reads,n);
});
