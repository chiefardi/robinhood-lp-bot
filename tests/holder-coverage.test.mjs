import test from 'node:test';
import assert from 'node:assert/strict';
import * as gmgn from '../src/radar/gmgn.ts';
import {securityFailure} from '../src/radar/entry-guard.ts';
const address=n=>'0x'+n.toString(16).padStart(40,'0');
const row=(n,p,tags=[],type=0,funder=null)=>({address:address(n),amount_percentage:p,addr_type:type,maker_token_tags:tags,native_transfer:{from_address:funder}});
// 40% pool custody + ten 4% normal wallets = 80% covered; 20% unobserved.
const rows=()=>[row(1,.4,['bundler'],2),...Array.from({length:10},(_,i)=>row(i+2,.04,i===0?['bundler']:[]))];
const safe=e=>({isHoneypot:false,buyTax:0,sellTax:0,observedAt:1000,holderEvidence:e});

test('coverage bound includes all unseen supply and excludes pool custody from tagged wallet exposure',()=>{
  assert.equal(typeof gmgn.analyzeHolderCoverage,'function');
  const e=gmgn.analyzeHolderCoverage({list:rows()},1000);
  assert.equal(e.status,'ok');
  assert.ok(Math.abs(e.coverageRate-.8)<1e-9);
  assert.ok(Math.abs(e.taggedRiskRate-.04)<1e-9);
  assert.ok(Math.abs(e.taggedRiskUpperRate-.24)<1e-9);
  assert.equal(e.largestWalletRate,.04);
  assert.equal(securityFailure(safe(e),5,1000),null);
});

test('low coverage cannot pass by reporting few observed bundlers or legacy invented fields',()=>{
  assert.equal(typeof gmgn.analyzeHolderCoverage,'function');
  const e=gmgn.analyzeHolderCoverage({list:[row(1,.4,[],2),row(2,.1)]},1000);
  assert.match(securityFailure(safe(e),5,1000),/coverage|unobserved/);
  assert.ok(securityFailure({...safe(undefined),currentLinkedHoldingRate:0,currentBundlerHoldingRate:0},5,1000));
});

test('malformed, duplicate, impossible totals, missing tags and unknown custody are not safe evidence',()=>{
  assert.equal(typeof gmgn.analyzeHolderCoverage,'function');
  for(const list of [[],[row(1,.6),row(1,.3)],[row(1,.6),row(2,.5)],[{...row(1,.8),maker_token_tags:undefined}],[row(1,NaN)],[row(1,-.1)],[row(1,'')],[row(1,.8,[],9)],[{...row(1,.8),address:'bad'}]]){
    const e=gmgn.analyzeHolderCoverage({list},1000);
    assert.equal(e.status,'unknown');
    assert.ok(securityFailure(safe(e),5,1000));
  }
});

test('large wallets and shared funders reject without calling funding a proof of common ownership',()=>{
  assert.equal(typeof gmgn.analyzeHolderCoverage,'function');
  const concentrated=gmgn.analyzeHolderCoverage({list:[row(1,.5,[],2),row(2,.3),row(3,.1)]},1000);
  assert.match(securityFailure(safe(concentrated),5,1000),/concentration/);
  const funded=rows();for(let i=1;i<=6;i++)funded[i].native_transfer.from_address=address(90);
  const e=gmgn.analyzeHolderCoverage({list:funded},1000);
  assert.ok(Math.abs(e.largestSharedFunderRate-.24)<1e-9);
  assert.match(securityFailure(safe(e),5,1000),/shared.funder/);
});

test('holder freshness is independent of security freshness; tag overlap is counted once',()=>{
  assert.equal(typeof gmgn.analyzeHolderCoverage,'function');
  const list=rows();list[1].maker_token_tags=['bundler','rat_trader','dev_team'];
  const e=gmgn.analyzeHolderCoverage({list},1000);
  assert.ok(Math.abs(e.taggedRiskRate-.04)<1e-9);
  assert.ok(securityFailure({...safe(e),observedAt:62000},5,62000));
  assert.ok(securityFailure(safe({...e,observedAt:2000}),5,1000));
});

test('burn custody, degenerate float, exact bounds and top-ten-only concentration',()=>{
 const list=rows();list[0].addr_type=1;
 assert.ok(Math.abs(gmgn.analyzeHolderCoverage({list},1000).taggedRiskUpperRate-.24)<1e-9);
 assert.equal(gmgn.analyzeHolderCoverage({list:[row(1,.99,[],1),row(2,.01)]},1000).status,'unknown');
 const concentrated=[row(1,.3,[],2),...Array.from({length:10},(_,i)=>row(i+2,.055))];
 assert.match(securityFailure(safe(gmgn.analyzeHolderCoverage({list:concentrated},1000)),5,1000),/concentration/);
 const boundary=[row(1,.4,[],2),...Array.from({length:6},(_,i)=>row(i+2,.05))];
 assert.equal(securityFailure(safe(gmgn.analyzeHolderCoverage({list:boundary},1000)),5,1000),null);
 boundary[1].amount_percentage=.049;
 assert.ok(securityFailure(safe(gmgn.analyzeHolderCoverage({list:boundary},1000)),5,1000));
});
