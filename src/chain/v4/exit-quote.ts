/**
 * READ ONLY estimated liquidation cash for automatic exit decisions.
 * All chain state (including ERC20 metadata) is read at one fresh block. Fees are
 * included, and each non-ETH leg gets a full-amount sell route, never a spot mark
 * or a symbol-based stablecoin peg. This is NOT guaranteed executable/realized
 * cash: removing our liquidity can worsen the later route, token taxes may not
 * be represented, routes can overlap, and the configured gas buffer is not a
 * transaction gas estimate. Hooked LPs are unsupported and fail closed.
 * No quotes/state are cached; ETH/USD has a 15-second cache, without stale fallback.
 * observedAt is the OLDEST input timestamp in milliseconds, not completion time.
 */
import { ethers } from "ethers";
import sdkCore from "@uniswap/sdk-core";
import v4sdk from "@uniswap/v4-sdk";
import { STATEVIEW_ABI, V4_POSM_ABI } from "./abis.js";
import { NATIVE, computePoolId } from "./poolkey.js";
import { freshEthUsd } from "../fresh-price.js";

const { Ether, Token } = sdkCore as any;
const { Pool, Position } = v4sdk as any;
const KYBER_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const MASK256 = (1n << 256n) - 1n;
const MAX_DELTA = (1n << 127n) - 1n;
const MAX_AGE_MS = 60_000;
const MAX_POSITION_USD = 1_000_000; // fail closed on corrupted/extreme farming-position values
const ERC20_META_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

export interface V4ExitQuote { netUsd: number; observedAt: number; blockNumber: number }
interface QuoteBlock { number: number; timestamp: number; hash: string | null }
interface ContractRead {
  address: string; abi: readonly string[]; functionName: string; args: unknown[]; blockTag: number;
}
export interface ExitSellQuote {
  tokenIn: string; tokenOut: string; amountIn: string; amountOut: string; observedAt: number;
}
/** Network boundary, also usable by alternative read-only RPC/price adapters. */
export interface V4ExitQuoteDependencies {
  owner: string; positionManager: string; stateView: string; weth: string; chainId: number;
  slippagePct: number; exitCostBufferUsd: number;
  now(): number;
  getBlock(tag: "latest" | number): Promise<QuoteBlock | null>;
  readContract(request: ContractRead): Promise<any>;
  sellQuote(tokenIn: string, amountIn: bigint): Promise<ExitSellQuote | null>;
  ethReference(): Promise<{usd: number; observedAt: number}>;
}

function requireValue(ok: unknown, label: string): asserts ok {
  if (!ok) throw new Error(`v4 exit quote unavailable: ${label}`);
}
function uint(value: unknown, bits: number, label: string): bigint {
  requireValue(typeof value === "bigint" || (typeof value === "string" && /^\d+$/.test(value)), label);
  const n = BigInt(value);
  requireValue(n >= 0n && n < (1n << BigInt(bits)), label);
  return n;
}
function fresh(at: number, now: number, label: string): void {
  requireValue(Number.isSafeInteger(at) && at > 0 && Number.isSafeInteger(now) && at <= now && now - at <= MAX_AGE_MS, `${label} stale/invalid`);
}
const addr = (value: string): string => ethers.getAddress(value).toLowerCase();
const signed24 = (n: number): number => n >= 0x800000 ? n - 0x1000000 : n;

export function createV4ExitQuoter(d: V4ExitQuoteDependencies): (tokenId: string) => Promise<V4ExitQuote> {
  return async tokenId => {
    requireValue(/^\d+$/.test(tokenId) && uint(tokenId, 256, "tokenId") > 0n, "tokenId");
    requireValue(Number.isFinite(d.slippagePct) && d.slippagePct >= 0 && d.slippagePct <= 50, "slippage");
    requireValue(Number.isFinite(d.exitCostBufferUsd) && d.exitCostBufferUsd >= 0 && d.exitCostBufferUsd < MAX_POSITION_USD, "exit cost buffer");
    const owner = addr(d.owner), weth = addr(d.weth);
    requireValue(owner !== NATIVE && weth !== NATIVE, "owner/WETH address");
    const block = await d.getBlock("latest");
    requireValue(block && Number.isSafeInteger(block.number) && block.number > 0 && /^0x[\da-f]{64}$/i.test(block.hash ?? ""), "block");
    fresh(block.timestamp * 1000, d.now(), "block");
    const read = (address: string, abi: readonly string[], functionName: string, args: unknown[] = []) =>
      d.readContract({address, abi, functionName, args, blockTag: block.number});
    const [actualOwner, liquidityRaw, poolInfo] = await Promise.all([
      read(d.positionManager, V4_POSM_ABI, "ownerOf", [tokenId]),
      read(d.positionManager, V4_POSM_ABI, "getPositionLiquidity", [tokenId]),
      read(d.positionManager, V4_POSM_ABI, "getPoolAndPositionInfo", [tokenId]),
    ]);
    requireValue(addr(actualOwner) === owner, "position not owned");
    const liquidity = uint(liquidityRaw, 128, "liquidity");
    requireValue(liquidity > 0n, "empty position");
    requireValue(poolInfo?.length === 2, "pool info");
    const pk = poolInfo[0], info = uint(poolInfo[1], 256, "position info");
    const currency0 = addr(pk.currency0), currency1 = addr(pk.currency1);
    requireValue(currency0 < currency1, "currency order");
    requireValue(addr(pk.hooks) === NATIVE, "hooks unsupported");
    const fee = Number(pk.fee), tickSpacing = Number(pk.tickSpacing);
    requireValue(Number.isInteger(fee) && fee >= 0 && fee < 1_000_000, "pool fee");
    requireValue(Number.isInteger(tickSpacing) && tickSpacing > 0 && tickSpacing <= 32767, "tick spacing");
    const tickLower = signed24(Number((info >> 8n) & 0xffffffn));
    const tickUpper = signed24(Number((info >> 32n) & 0xffffffn));
    requireValue(tickLower >= -887272 && tickUpper <= 887272 && tickLower < tickUpper && tickLower % tickSpacing === 0 && tickUpper % tickSpacing === 0, "tick bounds");
    const poolId = computePoolId({currency0, currency1, fee, tickSpacing, hooks: NATIVE});
    const positionId = ethers.solidityPackedKeccak256(
      ["address", "int24", "int24", "bytes32"],
      [d.positionManager, tickLower, tickUpper, ethers.toBeHex(BigInt(tokenId), 32)],
    );
    const metadata = async (a: string) => {
      if (a === NATIVE) return {decimals: 18, symbol: "ETH"};
      const [rawDecimals, symbol] = await Promise.all([
        read(a, ERC20_META_ABI, "decimals"), read(a, ERC20_META_ABI, "symbol"),
      ]);
      const decimals = Number(uint(rawDecimals, 8, "decimals"));
      requireValue(decimals <= 36 && (a !== weth || decimals === 18), "unsupported decimals");
      requireValue(typeof symbol === "string" && symbol.trim().length > 0 && symbol.length <= 64 && symbol !== "?", "unknown metadata");
      return {decimals, symbol};
    };
    const [s0, growth, posInfo, meta0, meta1] = await Promise.all([
      read(d.stateView, STATEVIEW_ABI, "getSlot0", [poolId]),
      read(d.stateView, STATEVIEW_ABI, "getFeeGrowthInside", [poolId, tickLower, tickUpper]),
      read(d.stateView, STATEVIEW_ABI, "getPositionInfo", [poolId, positionId]),
      metadata(currency0), metadata(currency1),
    ]);
    requireValue(s0?.length === 4 && growth?.length === 2 && posInfo?.length === 3, "incomplete pool state");
    requireValue(typeof s0[1] === "bigint", "missing tick");
    uint(s0[2], 24, "protocol fee");
    requireValue(uint(s0[3], 24, "LP fee") === BigInt(fee), "static fee mismatch");
    const sqrt = uint(s0[0], 160, "sqrt price"), tick = Number(s0[1]);
    requireValue(sqrt > 0n && Number.isInteger(tick) && tick >= -887272 && tick < 887272, "sqrt/tick");
    requireValue(uint(posInfo[0], 128, "position liquidity") === liquidity, "liquidity mismatch");
    const currencies = [currency0, currency1].map((a, i) => {
      const m = i === 0 ? meta0 : meta1;
      return a === NATIVE ? Ether.onChain(d.chainId) : new Token(d.chainId, ethers.getAddress(a), m.decimals, m.symbol);
    });
    const pool = new Pool(currencies[0], currencies[1], fee, tickSpacing, NATIVE, sqrt.toString(), "0", tick);
    const position = new Position({pool, liquidity: liquidity.toString(), tickLower, tickUpper});
    const amounts = [position.amount0, position.amount1].map((principal, i) => {
      const feeGrowth = (uint(growth[i], 256, "fee growth") - uint(posInfo[i + 1], 256, "last fee growth")) & MASK256;
      const fees = (feeGrowth * liquidity) >> 128n;
      const amount = uint(principal.quotient.toString(), 256, "principal") + fees;
      requireValue(amount <= MAX_DELTA, "implausible token amount");
      return amount;
    });
    requireValue(amounts.some(a => a > 0n), "zero asset amounts");
    const price = await d.ethReference();
    requireValue(Number.isFinite(price.usd) && price.usd > 0 && price.usd < MAX_POSITION_USD, "ETH/USD");
    fresh(price.observedAt, d.now(), "ETH/USD");
    const timestamps = [block.timestamp * 1000, price.observedAt];
    const legValues = await Promise.all([currency0, currency1].map(async (currency, i) => {
      const amount = amounts[i]!;
      if (amount === 0n) return 0;
      let ethAmount = amount;
      if (currency !== NATIVE && currency !== weth) {
        const quote = await d.sellQuote(currency, amount);
        requireValue(quote, "no sell route");
        fresh(quote.observedAt, d.now(), "sell quote");
        timestamps.push(quote.observedAt);
        requireValue(addr(quote.tokenIn) === currency && addr(quote.tokenOut) === KYBER_NATIVE, "route currencies");
        requireValue(uint(quote.amountIn, 256, "route input") === amount, "route input mismatch");
        const rawOut = uint(quote.amountOut, 256, "route output");
        requireValue(rawOut > 0n, "empty route output");
        // Round the haircut UP to a basis point, then output DOWN to wei.
        ethAmount = rawOut * BigInt(10_000 - Math.ceil(d.slippagePct * 100)) / 10_000n;
      }
      const usd = Number(ethers.formatEther(ethAmount)) * price.usd;
      requireValue(Number.isFinite(usd) && usd >= 0 && usd < MAX_POSITION_USD, "implausible leg USD");
      return usd;
    }));
    // Guard against an orphaned snapshot and requests whose latency exhausted freshness.
    const recheck = await d.getBlock(block.number);
    requireValue(recheck?.hash === block.hash, "block changed");
    const observedAt = Math.min(...timestamps);
    fresh(observedAt, d.now(), "completed quote");
    const grossUsd = legValues.reduce((sum, usd) => sum + usd, 0);
    requireValue(Number.isFinite(grossUsd) && grossUsd < MAX_POSITION_USD, "implausible total USD");
    return {netUsd: Math.max(0, grossUsd - d.exitCostBufferUsd), observedAt, blockNumber: block.number};
  };
}

export async function quoteV4Exit(tokenId: string): Promise<V4ExitQuote> {
  const [{C, cfg, env}, {provider, wallet}, {kyberRoute}] = await Promise.all([
    import("../../config.js"), import("../client.js"), import("../kyber.js"),
  ]);
  requireValue(C.v4PositionManager && C.v4StateView, "v4 contracts not configured");
  const quote = createV4ExitQuoter({
    owner: wallet().address, // address only; no signing/build/approval/broadcast occurs here
    positionManager: C.v4PositionManager, stateView: C.v4StateView, weth: C.weth,
    chainId: cfg.chainId, slippagePct: cfg.lp.slippagePct, exitCostBufferUsd: cfg.autoLp.exitCostBufferUsd,
    now: Date.now,
    getBlock: tag => provider.getBlock(tag),
    readContract: async r => {
      const contract = new ethers.Contract(r.address, r.abi, provider);
      return contract.getFunction(r.functionName).staticCall(...r.args, {blockTag: r.blockTag});
    },
    sellQuote: async (tokenIn, amountIn) => {
      requireValue(env.kyberRouter, "Kyber router not configured");
      const observedAt = Date.now();
      const route = await kyberRoute(tokenIn, KYBER_NATIVE, amountIn);
      requireValue(route && addr(route.routerAddress) === addr(env.kyberRouter), "untrusted/missing sell route");
      requireValue(Array.isArray(route.routeSummary?.route) && route.routeSummary.route.length > 0, "empty sell route");
      return {...route.routeSummary, observedAt};
    },
    ethReference: freshEthUsd,
  });
  return quote(tokenId);
}
