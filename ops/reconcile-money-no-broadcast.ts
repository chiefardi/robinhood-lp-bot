/** One incident only. Stop systemd first. Does NOT resume entries or reset limits. */
import fs from 'node:fs';
import {ethers} from 'ethers';
import {C,cfg} from '../src/config.js';
import {provider,wallet} from '../src/chain/client.js';
import {USDG} from '../src/chain/v4/discover.js';
import {riskStore} from '../src/radar/auto-risk.js';
import {dataPath} from '../src/util/files.js';

try {
 const owner=wallet().address;
 if(owner.toLowerCase()!=='0x6b35346eb095720f21d35fb0c62db7a409d45f75'||cfg.chainId!==4663)throw Error('Wrong incident wallet/chain');
 const session=riskStore.snapshot();
 const id='add824fd-fafb-4db7-b774-f55d7366834c';
 if(session?.id!=='9b1115a8-4ddb-4c4c-94bd-7d1bfe2d20d2'||!session.paused||session.lossTriggered||session.entries.length!==1||
    session.entries[0]?.id!==id||session.entries[0].status!=='uncertain'||session.entries[0].token.toLowerCase()!=='0x0a8b4763c71ac39101b3b8a97e62da0b81549a4f')throw Error('Incident ledger changed; refuse reconciliation');
 const block=await provider.getBlock('latest');
 if(!block?.hash||Date.now()-block.timestamp*1000>60_000||block.timestamp*1000>Date.now())throw Error('Block unavailable/stale');
 const abi=['function balanceOf(address) view returns(uint256)'];
 const balance=(a:string)=>new ethers.Contract(a,abi,provider).balanceOf!(owner,{blockTag:block.number});
 const [network,latestNonce,pendingNonce,native,weth,usdg,v3,v4,canonical]=await Promise.all([
   provider.getNetwork(),provider.getTransactionCount(owner,block.number),provider.getTransactionCount(owner,'pending'),
   provider.getBalance(owner,block.number),balance(C.weth),balance(USDG),balance(C.positionManager),balance(C.v4PositionManager!),provider.getBlock(block.number)]);
 if(network.chainId!==4663n||canonical?.hash!==block.hash)throw Error('Chain/canonical block mismatch');
 if(latestNonce!==0||pendingNonce!==0||native!==41000000000000000n||weth!==0n||usdg!==0n||v3!==0n||v4!==0n)throw Error('Not the unchanged pristine wallet; no reconciliation');
 const proof={chainId:4663 as const,wallet:owner,blockNumber:block.number,blockHash:block.hash,observedAt:block.timestamp*1000,
   latestNonce:0 as const,pendingNonce:0 as const,nativeWei:native.toString(),expectedNativeWei:'41000000000000000',wethWei:'0' as const,usdgRaw:'0' as const,
   v3Count:0 as const,v4Count:0 as const,reason:'MONEY 2026-09-18T14:44:09Z missing Kyber config throw before wallet access; zero outgoing nonce and unchanged funding verified'};
 if(process.argv.includes('--apply')){
   const file=dataPath('auto-risk.json');fs.copyFileSync(file,file+'.before-reconcile-'+Date.now(),fs.constants.COPYFILE_EXCL);
   riskStore.reconcileNeverBroadcast(id,proof);
 }
 console.log(JSON.stringify({proof,applied:process.argv.includes('--apply'),entriesRemainPaused:true,attemptsRemainCharged:1},null,2));
}catch(e:any){console.error(String(e.shortMessage??e.message??'Reconciliation failed').slice(0,240));process.exitCode=1;}
