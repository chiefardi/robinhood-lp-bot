import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('pilot isolates financial Telegram actions but keeps reads and pause controls available',async()=>{
  assert.ok(fs.existsSync('src/telegram/manual-guard.ts'),'manual isolation guard required');
  const {isFinancialMessage,isFinancialCallback}=await import('../src/telegram/manual-guard.ts');
  for(const cmd of ['/swap 1 ETH USDG','/v4lp a','/v4close 1','/v2close 2','/sell','/closeall','0.02','/set alpsize 1','/v4closeX 123','/v4lpX a','/swapX 1 ETH USDG'])assert.equal(isFinancialMessage(cmd),true,cmd);
  for(const cmd of ['/list','/wallet','/auto pause','/auto off','/screen','/settings'])assert.equal(isFinancialMessage(cmd),false,cmd);
  for(const cmd of ['swapdo','ballp','usdgw','mint:v4','mint','v4f:1','cs:1','ck:1','v4c:1','closeall','add4:1'])assert.equal(isFinancialCallback(cmd),true,cmd);
  for(const cmd of ['refresh','screen','ca:0x123','cancel','lg:0'])assert.equal(isFinancialCallback(cmd),false,cmd);
});
