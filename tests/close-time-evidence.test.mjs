import test from 'node:test';
import assert from 'node:assert/strict';
test('historical writes require exact reviewed receipt identity, not a nearby unrelated sweep',async()=>{
 const {assertReviewedCloseTime}=await import('../src/radar/close-time-evidence.ts');
 const proof={tokenId:'1',closedAt:1_800_000_000_000,txHash:'0x'+'a'.repeat(64),burnTx:'0x'+'b'.repeat(64),blockNumber:123};
 assert.doesNotThrow(()=>assertReviewedCloseTime(proof,[proof]));
 assert.throws(()=>assertReviewedCloseTime(proof,[]),/reviewed/i);
 assert.throws(()=>assertReviewedCloseTime({...proof,txHash:'0x'+'c'.repeat(64)},[proof]),/reviewed/i);
 assert.throws(()=>assertReviewedCloseTime({...proof,closedAt:proof.closedAt+1000},[proof]),/reviewed/i);
 assert.throws(()=>assertReviewedCloseTime(proof,[proof,proof]),/reviewed/i);
});
