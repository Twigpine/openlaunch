/** Exact atom/lamport arithmetic. Virtual SOL is never available liquidity. */
export const FIXED_SUPPLY = 1_000_000_000_000_000n;
export const TOKEN_DECIMALS = 6;
export const BPS = 10_000n;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const MIN_VIRTUAL_SOL = 1_000_000_000n;
export const MAX_VIRTUAL_SOL = 1_000_000_000_000_000n;
export const FEE_BPS = [0, 100, 300] as const;

export type CurveState = {
  tokenInventory: bigint;
  realSolReserves: bigint;
  virtualSol: bigint;
  feeBps: number;
};
export type TradeQuote = {
  grossInput: bigint;
  netInput: bigint;
  fee: bigint;
  amountOut: bigint;
  nextTokenInventory: bigint;
  nextRealSolReserves: bigint;
};

export function bounded(value: bigint, max: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > max) throw new RangeError(`${name} is out of bounds`);
  return value;
}
export function validateCurve(state: CurveState): void {
  bounded(state.tokenInventory, FIXED_SUPPLY, "Token inventory");
  bounded(state.realSolReserves, U64_MAX, "Real SOL reserves");
  bounded(state.virtualSol, MAX_VIRTUAL_SOL, "Virtual SOL");
  if (state.tokenInventory === 0n || state.virtualSol < MIN_VIRTUAL_SOL) throw new RangeError("Invalid inventory or virtual SOL");
  if (!FEE_BPS.some((fee) => fee === state.feeBps)) throw new RangeError("Fee must be 0, 100, or 300 basis points");
  bounded(state.realSolReserves + state.virtualSol, U64_MAX, "Effective reserves");
  if (state.tokenInventory * (state.realSolReserves + state.virtualSol) < FIXED_SUPPLY * state.virtualSol) {
    throw new RangeError("Pool invariant violated");
  }
}
export function tradingFee(amount: bigint, feeBps: number): bigint {
  bounded(amount, U64_MAX, "Fee basis amount");
  if (!FEE_BPS.some((fee) => fee === feeBps)) throw new RangeError("Unsupported fee");
  const product = amount * BigInt(feeBps);
  return product / BPS + (product % BPS === 0n ? 0n : 1n);
}
export function quoteBuy(state: CurveState, grossLamports: bigint, minOutput = 1n): TradeQuote {
  validateCurve(state);
  bounded(grossLamports, U64_MAX, "Buy input");
  bounded(minOutput, U64_MAX, "Minimum output");
  const fee = tradingFee(grossLamports, state.feeBps);
  const netInput = grossLamports - fee;
  if (netInput <= 0n) throw new RangeError("Buy input is too small after fees");
  const denominator = bounded(state.realSolReserves + state.virtualSol + netInput, U64_MAX, "Effective reserves after buy");
  const amountOut = state.tokenInventory * netInput / denominator;
  if (amountOut <= 0n || amountOut >= state.tokenInventory || amountOut < minOutput) throw new RangeError("Buy output is zero or below minimum");
  return { grossInput: grossLamports, netInput, fee, amountOut,
    nextTokenInventory: state.tokenInventory - amountOut, nextRealSolReserves: state.realSolReserves + netInput };
}
export function quoteSell(state: CurveState, tokenAtoms: bigint, minOutput = 1n): TradeQuote {
  validateCurve(state);
  bounded(tokenAtoms, U64_MAX, "Sell input");
  bounded(minOutput, U64_MAX, "Minimum output");
  if (tokenAtoms === 0n || tokenAtoms > FIXED_SUPPLY - state.tokenInventory) throw new RangeError("Sell exceeds circulating inventory");
  const grossOutput = (state.realSolReserves + state.virtualSol) * tokenAtoms / (state.tokenInventory + tokenAtoms);
  if (grossOutput > state.realSolReserves) throw new RangeError("Sell would spend virtual SOL");
  const fee = tradingFee(grossOutput, state.feeBps);
  const amountOut = grossOutput - fee;
  if (amountOut <= 0n || amountOut < minOutput) throw new RangeError("Sell output is zero or below minimum");
  return { grossInput: tokenAtoms, netInput: tokenAtoms, fee, amountOut,
    nextTokenInventory: state.tokenInventory + tokenAtoms, nextRealSolReserves: state.realSolReserves - grossOutput };
}
/** Same checked-u128 quotient/remainder formula as the program, avoiding F * weight overflow. */
export function feeEntitlement(cumulativeFees: bigint, weightBps: number): bigint {
  bounded(cumulativeFees, U128_MAX, "Cumulative fees");
  if (!Number.isInteger(weightBps) || weightBps < 1 || weightBps > 10_000) throw new RangeError("Invalid beneficiary weight");
  const weight = BigInt(weightBps);
  return cumulativeFees / BPS * weight + cumulativeFees % BPS * weight / BPS;
}
export function claimableFees(cumulativeFees: bigint, weightBps: number, paid: bigint): bigint {
  bounded(paid, U128_MAX, "Paid fees");
  const entitlement = feeEntitlement(cumulativeFees, weightBps);
  if (paid > entitlement) throw new RangeError("Paid fees exceed entitlement");
  return entitlement - paid;
}
export function minimumAfterSlippage(amountOut: bigint, slippageBps: number): bigint {
  bounded(amountOut, U64_MAX, "Quoted output");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new RangeError("Slippage must be below 100%");
  const result = amountOut * (BPS - BigInt(slippageBps)) / BPS;
  if (result <= 0n) throw new RangeError("Slippage minimum would be zero");
  return result;
}
/** Parse without float rounding or scientific notation. */
export function parseAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new RangeError("Invalid decimal precision");
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw new RangeError("Use an unsigned decimal amount");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new RangeError("Too many decimal places");
  return bounded(BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0"), U64_MAX, "Amount");
}
export function formatAmount(value: bigint, decimals: number): string {
  bounded(value, U128_MAX, "Amount");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new RangeError("Invalid decimal precision");
  const text = value.toString().padStart(decimals + 1, "0");
  if (decimals === 0) return text;
  // Trailing zeros trimmed by index, not by regex: the input is library data (CodeQL js/polynomial-redos).
  let end = decimals;
  while (end > 0 && text[text.length - decimals + end - 1] === "0") end--;
  const fraction = text.slice(text.length - decimals, text.length - decimals + end);
  return `${text.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}
