import test from 'node:test';
import assert from 'node:assert/strict';
import * as scanner from '../src/watch/scanner.ts';

test('watch discovery uses five-minute volume leaders and rejects an empty feed', async () => {
  assert.equal(typeof scanner.discoverWatchTokens, 'function');
  let requested;
  const rows = await scanner.discoverWatchTokens(300, async options => {
    requested = options;
    return [
      {address:'0x1111111111111111111111111111111111111111',symbol:'FIRST'},
      {address:'0x2222222222222222222222222222222222222222',symbol:'SECOND'},
      {address:'bad',symbol:'BAD'},
      {address:'0x1111111111111111111111111111111111111111',symbol:'DUPLICATE'},
    ];
  });
  assert.deepEqual(requested,{interval:'5m',orderBy:'volume',limit:100,minVolume:0,minLiquidity:0,minMarketCap:0});
  assert.deepEqual(rows,[
    {addr:'0x1111111111111111111111111111111111111111',symbol:'FIRST'},
    {addr:'0x2222222222222222222222222222222222222222',symbol:'SECOND'},
  ]);
  await assert.rejects(scanner.discoverWatchTokens(300,async()=>[]),/watch token discovery unavailable/i);
});

test('market lookup reads each Robinhood token even when a multi-token response would be truncated', async () => {
  assert.equal(typeof scanner.marketData, 'function');
  const addresses = [
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222',
  ];
  const urls=[];
  const fetcher=async url=>{
    urls.push(url);
    const addr=url.split('/').at(-1);
    return {ok:true,status:200,json:async()=>[{chainId:'robinhood',baseToken:{address:addr,symbol:addr===addresses[0]?'FIRST':'SECOND'},volume:{m5:600000,h1:1400000,h24:4000000},liquidity:{usd:100000},priceUsd:'0.01',priceChange:{m5:2,h1:8},fdv:1000000,pairAddress:'0x3333333333333333333333333333333333333333'}]};
  };
  const rows=await scanner.marketData(addresses,fetcher,async()=>{});
  assert.equal(urls.length,2);
  assert.deepEqual(urls,addresses.map(a=>'https://api.dexscreener.com/token-pairs/v1/robinhood/'+a));
  assert.deepEqual(Object.keys(rows),addresses);
  assert.equal(rows[addresses[1]].vol5m,600000);
});
