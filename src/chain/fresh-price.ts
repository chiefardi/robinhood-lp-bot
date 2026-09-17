/**
 * Fresh read-only ETH/USD reference for cash accounting and exit estimates.
 * Cache TTL is 15 seconds; expired values are NEVER returned on failure.
 * Coinbase's spot endpoint has no market timestamp: observedAt is request start,
 * not a guarantee about its upstream market feed. CoinGecko's upstream timestamp
 * is retained. Both HTTP requests have an 8-second timeout and no-cache headers.
 */
export interface FreshEthPrice { usd: number; observedAt: number }
let cache: FreshEthPrice | null = null;
const isFresh = (at: number, now: number): boolean => Number.isSafeInteger(at) && at > 0 && at <= now && now - at <= 60_000;

export async function freshEthUsd(): Promise<FreshEthPrice> {
  const now = Date.now();
  if (cache && isFresh(cache.observedAt, now) && now - cache.observedAt < 15_000) return {...cache};
  for (const [url, extract] of [
    ["https://api.coinbase.com/v2/prices/ETH-USD/spot", (j: any, started: number) => {
      if (j?.data?.currency !== "USD") throw new Error("invalid reference currency");
      return {usd: Number(j.data.amount), observedAt: started};
    }],
    ["https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_last_updated_at=true", (j: any, started: number) => {
      const updated = Number(j?.ethereum?.last_updated_at) * 1000;
      if (!isFresh(updated, Date.now())) throw new Error("stale reference source");
      return {usd: Number(j?.ethereum?.usd), observedAt: Math.min(started, updated)};
    }],
  ] as const) {
    const started = Date.now();
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(8000), headers: {"cache-control": "no-cache"}});
      if (!response.ok) continue;
      const price = extract(await response.json(), started);
      if (!Number.isFinite(price.usd) || price.usd <= 0 || price.usd >= 1_000_000 || !isFresh(price.observedAt, Date.now())) continue;
      cache = price;
      return {...price};
    } catch { /* Try a fresh independent reference, never an expired cache. */ }
  }
  throw new Error("No fresh ETH/USD reference available");
}
