/** Native RPC balances use 18 decimals, including Arc's 6-decimal ERC-20 USDC face. */
export function requiredTradeNativeBalance({ amountIn, spendsNativeBalance, quoteDecimals, reserveWei }: {
  amountIn: bigint | null;
  spendsNativeBalance: boolean;
  quoteDecimals: number;
  reserveWei: bigint;
}): bigint {
  if (!spendsNativeBalance || amountIn === null) return reserveWei;
  const spend = quoteDecimals <= 18
    ? amountIn * 10n ** BigInt(18 - quoteDecimals)
    : (amountIn + 10n ** BigInt(quoteDecimals - 18) - 1n) / 10n ** BigInt(quoteDecimals - 18);
  return spend + reserveWei;
}

/** Never treat an unknown/failed balance as zero or as permission to request a signature. */
export function tradeGasStatus(balance: bigint | undefined, failed: boolean, required: bigint): "loading" | "error" | "insufficient" | "ready" {
  if (failed) return "error";
  if (balance === undefined) return "loading";
  return balance < required ? "insufficient" : "ready";
}
