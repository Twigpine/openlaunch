/**
 * How far a trade moves a Uniswap v4 pool's price, with the pool fee taken out: 1 − (the quoter's output ÷ what the
 * same input would fetch at the pre-trade spot price after the fee). Pure; the spot comes from StateView.getSlot0
 * and the output from the V4 Quoter, both read by the trade panel.
 */
const Q96 = 2 ** 96;
/** Above this the impact line turns amber. */
export const IMPACT_WARN = 0.05;
/** Above this the trade needs a second, deliberate tap. */
export const IMPACT_CONFIRM = 0.15;

/** currency1 per currency0, in raw units, from sqrtPriceX96. */
export function spotPrice1Per0(sqrtPriceX96: bigint): number {
  const root = Number(sqrtPriceX96) / Q96;
  return root * root;
}

/**
 * `zeroForOne`: paying currency0 for currency1 (a buy, when the quote is currency0). `feePips` is the pool's LP
 * fee in millionths, charged on the input. Null when the inputs cannot give a meaningful answer.
 */
export function priceImpact({ sqrtPriceX96, amountIn, amountOut, zeroForOne, feePips }: { sqrtPriceX96: bigint; amountIn: bigint; amountOut: bigint; zeroForOne: boolean; feePips: number }): number | null {
  if (sqrtPriceX96 <= 0n || amountIn <= 0n || amountOut < 0n || feePips < 0 || feePips >= 1_000_000) return null;
  const price = spotPrice1Per0(sqrtPriceX96);
  const afterFee = Number(amountIn) * (1 - feePips / 1_000_000);
  const ideal = zeroForOne ? afterFee * price : afterFee / price;
  if (!Number.isFinite(ideal) || ideal <= 0) return null;
  // rounding in the quoter can land a hair above the ideal on a tiny trade: that is zero impact, not negative
  return Math.min(1, Math.max(0, 1 - Number(amountOut) / ideal));
}

export type ImpactLevel = "low" | "warn" | "confirm";

export function impactLevel(impact: number): ImpactLevel {
  return impact >= IMPACT_CONFIRM ? "confirm" : impact >= IMPACT_WARN ? "warn" : "low";
}

/** "<0.01%", "0.42%", "4.2%", "37%". */
export function fmtImpact(impact: number): string {
  const pct = impact * 100;
  if (pct < 0.01) return "<0.01%";
  if (pct < 1) return `${pct.toFixed(2)}%`;
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}
