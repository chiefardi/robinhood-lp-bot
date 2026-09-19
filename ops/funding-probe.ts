/** Read-only: no approval, signing, sendTransaction, or ledger mutation. */
import {ethers} from 'ethers';
import {C,cfg,env} from '../src/config.js';
import {wallet,provider} from '../src/chain/client.js';
import {preflightKyberFunding} from '../src/chain/kyber.js';
import {USDG} from '../src/chain/v4/discover.js';
import {freshEntryPrice,strictCashSnapshot,strictInventory} from '../src/radar/entry-guard.js';
import {riskStore} from '../src/radar/auto-risk.js';

try {
 const price=await freshEntryPrice();
 const owner=wallet().address;
 const amount=ethers.parseEther((cfg.autoLp.sizeUsd/price.usd).toFixed(18));
 const snapshot=await strictCashSnapshot();
 await strictInventory(riskStore.openPositions().map(p=>p.tokenId));
 const [funding,nonce,pendingNonce]=await Promise.all([
   preflightKyberFunding(USDG,amount),provider.getTransactionCount(owner),provider.getTransactionCount(owner,'pending')]);
 const contracts=await Promise.all([C.v4PositionManager,C.v4StateView,'0x000000000022D473030F116dDEE9F6B43aC78BA3'].map(async address=>({address,hasCode:!!address&&(await provider.getCode(address))!=='0x'})));
 if(contracts.some(c=>!c.hasCode))throw new Error('Missing required LP contract code');
 console.log(JSON.stringify({chainId:cfg.chainId,wallet:owner,router:env.kyberRouter,nonce,pendingNonce,snapshot,
   sizeUsd:cfg.autoLp.sizeUsd,ethUsd:price.usd,amountInWei:amount.toString(),buyUsdGRaw:funding.amountOut.toString(),returnWei:funding.returnWei.toString(),
   roundtripQuotedPct:(Number(funding.returnWei)/Number(amount)-1)*100,contracts,
   buySimulation:'passed',returnBuild:'passed (not a sell simulation)',broadcast:false},null,2));
} catch(e:any){console.error(String(e.shortMessage??e.message??'Funding probe failed').slice(0,240));process.exitCode=1;}
