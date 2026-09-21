import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {RiskStore} from '../src/radar/auto-risk.ts';import {summarizeCash} from '../src/radar/cash-report.ts';
test('receipt-proven failed entry unwind releases execution block and records costs without inventing an NFT',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'unwind-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=1800000000000;
 const store=new RiskStore(path.join(dir,'risk.json'),()=>now);store.startSession();store.resumeEntries();const id=store.reserveEntry({token:'token',sizeUsd:29,sizeEth:.01});store.failEntry(id);now+=10000;
 const proof={cashDebitWei:'10100000000000000',cashReturnWei:'9500000000000000',entryEthUsd:2900,exitEthUsd:3000,observedAt:now,blockNumber:123,receiptHashes:['0x'+'a'.repeat(64)]};
 assert.equal(typeof store.reconcileUnwoundEntry,'function');
 for(const bad of [{cashDebitWei:'0'},{entryEthUsd:0},{observedAt:now-61000},{receiptHashes:[]},{cashReturnWei:'-1'}])assert.throws(()=>store.reconcileUnwoundEntry(id,{...proof,...bad}));
 store.reconcileUnwoundEntry(id,proof);const e=store.snapshot().entries[0];assert.equal(e.status,'closed');assert.equal(e.tokenId,undefined);assert.equal(e.basisUsd,29.29);assert.equal(e.realizedNetUsd,28.5);assert.equal(e.closeReason,'ENTRY_ABORT');assert.equal(e.at,now-10000);assert.equal(e.closedAt,now);assert.equal(store.executionBlocked(),false);assert.equal(store.snapshot().paused,true);assert.equal(store.snapshot().pauseKind,'manual');assert(Math.abs(summarizeCash(store.reportingSnapshot(),now).session.pnlUsd+.79)<1e-8);
 assert.throws(()=>store.reconcileUnwoundEntry(id,proof));
});
