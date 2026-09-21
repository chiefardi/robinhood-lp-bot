/** Token metadata cache + a builder for the Uniswap SDK `Token` object. */
import { ethers } from "ethers";
// CommonJS package under Node ESM — default-import then destructure the value.
import sdkCore from "@uniswap/sdk-core";
import type { Token as TokenT } from "@uniswap/sdk-core";
import { cfg } from "../config.js";
const { Token } = sdkCore;
import { provider } from "./client.js";
import { ERC20_ABI } from "./abis.js";
import type { TokenMeta } from "../types.js";

const metaCache = new Map<string, TokenMeta>();
const sdkCache = new Map<string, TokenT>();

// A .catch() only handles a REJECTION — not a HANG. A rug / giant-name / gas-bomb token's view call
// (or a momentarily stuck RPC) can leave symbol()/decimals() pending forever, which froze /list,
// /ledger and /pnl (all call tokenMeta per position). Bound each read: on timeout, use the fallback.
async function capRead<T>(p:Promise<T>,ms=5000):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([p,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(Error('Token metadata read timed out')),ms);})]);}
  finally{clearTimeout(timer);}
}

export async function tokenMeta(addr: string): Promise<TokenMeta> {
  const a = ethers.getAddress(addr);
  const hit = metaCache.get(a);
  if (hit) return hit;

  const c = new ethers.Contract(a, ERC20_ABI, provider);
  const [symbol, decimals, supply] = await Promise.all([
    capRead<string>(c.symbol!() as Promise<string>),
    capRead<number | bigint>(c.decimals!() as Promise<number | bigint>),
    capRead<bigint>(c.totalSupply!() as Promise<bigint>),
  ]);
  const dec = Number(decimals);
  if(typeof symbol!=='string'||!symbol.trim()||symbol==='?'||!Number.isInteger(dec)||dec<0||dec>36||typeof supply!=='bigint'||supply<0n)throw Error('Invalid token metadata');
  const m: TokenMeta = {
    addr: a,
    symbol: String(symbol),
    decimals: dec,
    supplyUi: Number(ethers.formatUnits(supply, dec)),
  };
  metaCache.set(a, m);
  return m;
}

/** SDK `Token` for pool/position math. Cached — building it hits tokenMeta once. */
export async function sdkToken(addr: string): Promise<TokenT> {
  const a = ethers.getAddress(addr);
  const hit = sdkCache.get(a);
  if (hit) return hit;
  const m = await tokenMeta(a);
  const t = new Token(cfg.chainId, a, m.decimals, m.symbol);
  sdkCache.set(a, t);
  return t;
}
