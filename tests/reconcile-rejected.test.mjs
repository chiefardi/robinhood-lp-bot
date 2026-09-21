import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RiskStore} from '../src/radar/auto-risk.ts';
test('nonzero nonce proof reconciles only a verified pre-broadcast rejection and keeps entries paused',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rejected-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let now=1800000000000;const store=new RiskStore(path.join(dir,'risk.json'),()=>now);
 store.startSession();store.resumeEntries();const id=store.reserveEntry({token:'token',sizeUsd:29,sizeEth:.01});store.failEntry(id);now+=100000;
 const proof={kind:'pre-broadcast-guard',chainId:4663,wallet:'0x'+'1'.repeat(40),beforeObservedAt:now-110000,observedAt:now,beforeNonce:53,latestNonce:53,pendingNonce:53,blockNumber:123,blockHash:'0x'+'a'.repeat(64),runtimeCommit:'3a28b48398409d939f2f22ae5eae86b208c39146',reason:'invalid strict pool'};
 for(const bad of [{latestNonce:54},{pendingNonce:54},{beforeObservedAt:now-1000},{observedAt:now-61000},{reason:'timeout'}])assert.throws(()=>store.reconcileNeverBroadcast(id,{...proof,...bad}));
 store.reconcileNeverBroadcast(id,proof);assert.equal(store.snapshot().entries[0].status,'aborted');assert.equal(store.snapshot().paused,true);assert.deepEqual(store.snapshot().entries[0].noBroadcastEvidence,proof);
 store.resumeEntries();assert.equal(store.entryBlockReason(29),null);
});
