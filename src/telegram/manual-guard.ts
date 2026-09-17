/** Wallet isolation: manual sends cannot race an active automatic experiment. */
export function isFinancialMessage(text:string):boolean {
  // Mirror the legacy router's startsWith semantics, including malformed suffixes.
  return /^\/(swap|v4lp|v4close|v2close)/i.test(text)||/^\/(sell|closeall|set)(?:\s|$)/i.test(text)||/^[0-9]*\.?[0-9]+$/.test(text);
}
export function isFinancialCallback(data:string):boolean {
  return /^(swapdo|ballp|usdgw|mint|v4f|v4c|v2c|cs|ck|closeall|add3|add4)(:|$)/.test(data);
}
