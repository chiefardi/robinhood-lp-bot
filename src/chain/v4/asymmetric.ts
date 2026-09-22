/** Prices are USDG per token, independent of PoolKey currency ordering. */
type State={sqrtPriceX96:bigint;tick:number;tickSpacing:number};
export function asymmetricRange(p:State,usdgIs0:boolean):{tickLower:number;tickUpper:number;fraction1:number} {
 const sp=p.tickSpacing,sqrt=Number(p.sqrtPriceX96)/2**96;
 const exactTick=2*Math.log(sqrt)/Math.log(1.0001);
 if(p.sqrtPriceX96<=0n||!Number.isFinite(exactTick)||!Number.isInteger(p.tick)||!Number.isInteger(sp)||sp<=0||sp>32767||exactTick<p.tick-1e-6||exactTick>=p.tick+1+1e-6)throw Error('Invalid asymmetric pool state');
 const lowRatio=usdgIs0?1/1.1:.8,highRatio=usdgIs0?1/.8:1.1;
 const tickLower=Math.floor((exactTick+Math.log(lowRatio)/Math.log(1.0001))/sp)*sp;
 const tickUpper=Math.ceil((exactTick+Math.log(highRatio)/Math.log(1.0001))/sp)*sp;
 if(tickLower < -887272 || tickUpper > 887272 || tickLower>=exactTick || tickUpper<=exactTick)throw Error('Asymmetric range outside usable ticks');
 // Normalize by current sqrt price; no token-decimal or price-unit assumption.
 const value0=1-Math.exp((exactTick-tickUpper)*Math.log(1.0001)/2);
 const value1=1-Math.exp((tickLower-exactTick)*Math.log(1.0001)/2);
 const fraction1=value1/(value0+value1);
 if(!Number.isFinite(fraction1)||fraction1<=0||fraction1>=1)throw Error('Invalid asymmetric allocation');
 return {tickLower,tickUpper,fraction1};
}

export function asymmetricBudget(p:State,usdgIs0:boolean,total:bigint){
 const range=asymmetricRange(p,usdgIs0);
 const amount1=total*BigInt(Math.round(range.fraction1*1e6))/1000000n;
 const amount0=total-amount1;
 if(amount0<=0n||amount1<=0n)throw Error('Asymmetric funding amount too small');
 return {...range,amount0,amount1};
}

type Funding={amountOut:bigint;returnWei:bigint;observedAt:number};
/** Read-only simulations/builds, never executes a swap. Sale builds are not sell simulations. */
export async function preflightAsymmetricFunding(
 p:State&{poolKey:{currency0:string;currency1:string}},usdg:string,total:bigint,
 read:(token:string,amount:bigint)=>Promise<Funding>,slPct:number,sizeUsd:number,gasReserveUsd:number,
):Promise<Funding> {
 const c0=p.poolKey.currency0,c1=p.poolKey.currency1;
 if((c0.toLowerCase()===usdg.toLowerCase())===(c1.toLowerCase()===usdg.toLowerCase()))throw Error('Asymmetric funding needs exactly one USDG side');
 if(!Number.isFinite(slPct)||slPct<=0||slPct>100||!Number.isFinite(sizeUsd)||sizeUsd<=0||!Number.isFinite(gasReserveUsd)||gasReserveUsd<0)throw Error('Invalid asymmetric cost budget');
 const b=asymmetricBudget(p,c0.toLowerCase()===usdg.toLowerCase(),total);
 const legs=await Promise.all([read(c0,b.amount0),read(c1,b.amount1)]);
 if(legs.some(l=>l.amountOut<=0n||l.returnWei<=0n||!Number.isFinite(l.observedAt)||l.observedAt<=0))throw Error('Invalid asymmetric funding evidence');
 const returnWei=legs[0]!.returnWei+legs[1]!.returnWei;
 const lossPct=(1-Number(returnWei)/Number(total)+gasReserveUsd/sizeUsd)*100;
 if(!Number.isFinite(lossPct)||lossPct>=slPct)throw Error('Asymmetric funding round trip exceeds pilot stop-loss budget');
 return {amountOut:0n,returnWei,observedAt:Math.min(...legs.map(l=>l.observedAt))};
}
