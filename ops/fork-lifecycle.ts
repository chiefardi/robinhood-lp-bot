/** Isolated Anvil fork only. Never reads the production key; all writes stay on loopback. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {ethers} from 'ethers';
const root=fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
if(!root.startsWith('/tmp/alexandria-fork-check.')||path.basename(root)!=='app')throw Error('Run only from the isolated /tmp fork copy');
if(process.env.RH_WALLET_KEY)throw Error('Do not load production environment into the fork harness');
const bin=process.argv[2];if(!bin?.startsWith('/tmp/alexandria-fork-check.'))throw Error('Explicit temporary Anvil binary required');
const endpoint='http://127.0.0.1:18549';
const fake=ethers.Wallet.createRandom();
Object.assign(process.env,{RH_RPC_URL:endpoint,RH_WATCH_RPC_URL:endpoint,RH_LOGS_RPC_URL:endpoint,RH_FAST_SUBMIT:'false',RH_WALLET_KEY:fake.privateKey,
 KYBERSWAP_ROUTER_ADDRESS:'0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',RH_TX_WAIT_MS:'20000'});
const anvil=spawn(bin,['--fork-url','https://rpc.mainnet.chain.robinhood.com','--host','127.0.0.1','--port','18549','--chain-id','4663','--block-time','1','--silent'],{stdio:'ignore',env:{PATH:process.env.PATH}});
try {
 const rpc=new ethers.JsonRpcProvider(endpoint,4663);
 let ready=false;
 for(let i=0;i<60;i++){
  try{await rpc.send('web3_clientVersion',[]);ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}
 }
 if(!ready)throw Error('Anvil did not start');
 await rpc.send('anvil_setBalance',[fake.address,ethers.toBeHex(ethers.parseEther('0.041'))]);
 const {cfg,C}=await import('../src/config.js');
 const {provider,wallet}=await import('../src/chain/client.js');
 if(wallet().address!==fake.address)throw Error('Unexpected fork signer');
 const {USDG}=await import('../src/chain/v4/discover.js');
 const {erc20PoolKey,computePoolId}=await import('../src/chain/v4/poolkey.js');
 const {STATEVIEW_ABI}=await import('../src/chain/v4/abis.js');
 const {freshEntryPrice,strictCashSnapshot,entryBasisUsd,strictInventory}=await import('../src/radar/entry-guard.js');
 const {preflightKyberFunding}=await import('../src/chain/kyber.js');
 const {openV4UsdgSingleSide}=await import('../src/chain/v4/mint.js');
 const {closeV4PositionStrict}=await import('../src/chain/v4/close.js');
 const {quoteV4Exit}=await import('../src/chain/v4/exit-quote.js');
 const {riskStore}=await import('../src/radar/auto-risk.js');
 const key=erc20PoolKey('0x0a8b4763c71ac39101b3b8a97e62da0b81549a4f',USDG,40000),poolId=computePoolId(key);
 const sv=new ethers.Contract(C.v4StateView!,STATEVIEW_ABI,provider);
 const [slot,liquidity]=await Promise.all([sv.getSlot0!(poolId),sv.getLiquidity!(poolId)]);
 const pool={poolKey:key,poolId,fee:key.fee,tickSpacing:key.tickSpacing,quote:'usd' as const,sqrtPriceX96:BigInt(slot.sqrtPriceX96),tick:Number(slot.tick),lpFee:Number(slot.lpFee),liquidity:BigInt(liquidity)};
 const price=await freshEntryPrice(),amount=(29/price.usd).toFixed(18);
 await preflightKyberFunding(USDG,ethers.parseEther(amount));
 await strictInventory([]);const before=await strictCashSnapshot();
 riskStore.startSession();riskStore.resumeEntries();const reservation=riskStore.reserveEntry({token:key.currency0,sizeUsd:29,sizeEth:Number(amount)});
 const strict={fixedEntryPrice:price.usd,sizeUsd:29,expectedPoolId:poolId,priceObservedAt:price.observedAt,assertActive:()=>{
  if(!riskStore.snapshot()?.entries.some(e=>e.id===reservation&&e.status==='reserved'))throw Error('Fork reservation inactive');
 }};
 const opened=await openV4UsdgSingleSide(pool,amount,{strict});
 if(!opened.tokenId)throw Error('Fork mint missing NFT');
 const after=await strictCashSnapshot(opened.blockNumber),basis=entryBasisUsd(before,after,price.usd);
 riskStore.commitEntry(reservation,{tokenId:opened.tokenId,basisUsd:basis});
 await strictInventory([opened.tokenId]);
 const quote=await quoteV4Exit(opened.tokenId);
 const closed=await closeV4PositionStrict(opened.tokenId,'manual');
 const final=await strictCashSnapshot(closed.confirmedBlockNumber);
 await strictInventory([]);
 console.log(JSON.stringify({simulation:'Anvil-only complete lifecycle',realMoneySpent:false,fakeWallet:fake.address,poolId,sizeUsd:29,basisUsd:basis,opened,exitQuote:quote,closed,final,roundtripCostUsd:(before.eth-final.eth)*price.usd,slippagePct:cfg.lp.slippagePct},null,2));
 await provider.destroy();await rpc.destroy();
}catch(e:any){console.error('FORK FAILED: '+String(e.shortMessage??e.message??e).slice(0,400));process.exitCode=1;}
finally{anvil.kill('SIGTERM');}
