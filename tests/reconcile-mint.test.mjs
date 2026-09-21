import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {RiskStore} from '../src/radar/auto-risk.ts';
test('operator recovers confirmed mint with audited cash basis without rearming or changing entry time',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mint-recover-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=1800000000000;
 const store=new RiskStore(path.join(dir,'risk.json'),()=>now);store.startSession();store.resumeEntries();const id=store.reserveEntry({token:'token',sizeUsd:29,sizeEth:.01});store.failEntry(id);now+=10000;
 const proof={tokenId:'123',cashDebitWei:'10000000000000000',ethUsd:2700,observedAt:now,blockNumber:123,receiptHashes:['0x'+'a'.repeat(64)]};
 assert.equal(typeof store.reconcileMintedEntry,'function');
 for(const bad of [{cashDebitWei:'0'},{ethUsd:-1},{observedAt:now-61000},{receiptHashes:[]}])assert.throws(()=>store.reconcileMintedEntry(id,{...proof,...bad}));
 store.reconcileMintedEntry(id,proof);const e=store.snapshot().entries[0];assert.equal(e.status,'open');assert.equal(e.basisUsd,27);assert.equal(e.at,now-10000);assert.equal(store.snapshot().paused,true);assert.deepEqual(e.entryRecoveryEvidence,proof);
 assert.throws(()=>store.reconcileMintedEntry(id,proof));
});
