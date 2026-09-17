import test from 'node:test';
import assert from 'node:assert/strict';
import * as guard from '../src/radar/entry-guard.ts';
test('exact pool activity blocks missing, stale, one-way and below-threshold volume',()=>{
 assert.equal(typeof guard.poolActivityFailure,'function');
 const pool={vol5m:600000,volH1:1500000,buys5m:30,sells5m:20,observedAt:1000};
 const limits={minVol5m:500000,minVol1h:1000000};
 assert.equal(guard.poolActivityFailure(pool,limits,1000),null);
 for(const patch of [{vol5m:undefined},{vol5m:NaN},{vol5m:499999},{volH1:999999},{buys5m:0},{sells5m:0},{observedAt:undefined},{observedAt:2000}])assert.ok(guard.poolActivityFailure({...pool,...patch},limits,1000));
 assert.ok(guard.poolActivityFailure(pool,limits,62000));
});
