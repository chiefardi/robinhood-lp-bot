/** Read-only by default. --apply adds verified time metadata only, under the stopped-bot lock. */
import {ethers} from 'ethers';
import {provider,wallet} from '../src/chain/client.js';
import {C,env} from '../src/config.js';
import {riskStore} from '../src/radar/auto-risk.js';
import {USDG} from '../src/chain/v4/discover.js';
import {acquireLock} from '../src/util/files.js';
import fs from 'node:fs';
import {assertReviewedCloseTime} from '../src/radar/close-time-evidence.js';

let release:(()=>void)|undefined;
try {
 const apply=process.argv.includes('--apply');
 const evidenceIndex=process.argv.indexOf('--evidence');
 const reviewed=apply&&evidenceIndex>=0?JSON.parse(fs.readFileSync(process.argv[evidenceIndex+1]!,'utf8')):null;
 if(apply&&!reviewed)throw Error('Reviewed evidence file required');
 if(apply)release=acquireLock();
 const owner=wallet().address,transfer=ethers.id('Transfer(address,address,uint256)');
 const ownerTopic=ethers.zeroPadValue(owner,32),zeroTopic=ethers.ZeroHash;
 const current=await provider.getBlockNumber();
 const proofs=[];
 for(const e of riskStore.snapshot()?.entries??[]){
  if(e.status!=='closed'||e.closedAt)continue;
  if(!e.blockNumber||!e.tokenId)throw Error('Historical pre-close block missing');
  const end=Math.min(current,e.blockNumber+2400);
  const burns=await provider.getLogs({address:C.v4PositionManager,fromBlock:e.blockNumber,toBlock:end,
   topics:[transfer,ownerTopic,zeroTopic,ethers.toBeHex(BigInt(e.tokenId),32)]});
  if(burns.length!==1)throw Error('Expected one exact owned NFT burn');
  const burn=burns[0]!,burnTx=await provider.getTransaction(burn.transactionHash);
  if(!burnTx||burnTx.from.toLowerCase()!==owner.toLowerCase())throw Error('Burn signer mismatch');
  const transfers=await provider.getLogs({address:[USDG,e.token],fromBlock:burn.blockNumber,toBlock:end,topics:[transfer,ownerTopic]});
  const hashes=[...new Set(transfers.map(l=>l.transactionHash))].filter(h=>h!==burn.transactionHash);
  const swaps=[];
  for(const hash of hashes){
   const tx=await provider.getTransaction(hash),receipt=await provider.getTransactionReceipt(hash);
   if(!tx||!receipt||receipt.status!==1||tx.from.toLowerCase()!==owner.toLowerCase()||tx.to?.toLowerCase()!==env.kyberRouter.toLowerCase()||tx.nonce<=burnTx.nonce||tx.nonce>burnTx.nonce+6)throw Error('Ambiguous historical sweep');
   swaps.push({hash,blockNumber:receipt.blockNumber,nonce:tx.nonce});
  }
  if(swaps.length<1||swaps.length>2)throw Error('Expected one or two successful cash sweeps');
  swaps.sort((a,b)=>a.nonce-b.nonce);const final=swaps.at(-1)!;
  const block=await provider.getBlock(final.blockNumber);
  if(!block||block.timestamp*1000<e.markAt!)throw Error('Invalid settlement timestamp');
  const proof={tokenId:e.tokenId,token:e.token,closedAt:block.timestamp*1000,txHash:final.hash,blockNumber:final.blockNumber,burnTx:burn.transactionHash,burnBlock:burn.blockNumber,swaps};
  proofs.push(proof);console.log(JSON.stringify(proof));
 }
 if(apply){
  for(const p of proofs)assertReviewedCloseTime(p,reviewed);
  for(const p of proofs)riskStore.backfillCloseTime(p.tokenId,p);
  console.log(`Verified timestamp metadata applied: ${proofs.length}`);
 }
}catch{console.error('Close-time evidence probe failed; inspect timestamp metadata before retry.');process.exitCode=1;}
finally{release?.();}
