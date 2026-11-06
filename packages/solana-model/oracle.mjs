// Deliberately independent of the program and SDK. Solve the invariant by
// monotone search, instead of implementing their closed-form swap quotients.
import assert from "node:assert/strict";

export const SUPPLY = 1_000_000_000_000_000n;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const MIN_VIRTUAL_SOL = 1_000_000_000n;
export const MAX_VIRTUAL_SOL = 1_000_000_000_000_000n;
const BPS = 10_000n;

function integer(value, name, max = U64_MAX) {
  assert.equal(typeof value, "bigint", `${name} must be bigint`);
  assert(value >= 0n && value <= max, `${name} out of bounds`);
}

// pred must be true for an initial interval starting at zero.
function largestTrue(limit, pred) {
  assert(pred(0n));
  let low = 0n;
  let high = limit + 1n;
  while (high - low > 1n) {
    const mid = (high + low) >> 1n;
    if (pred(mid)) low = mid;
    else high = mid;
  }
  return low;
}

export function feeOracle(amount, feeBps) {
  integer(amount, "fee amount");
  assert([0, 100, 300].includes(feeBps), "unsupported fee");
  if (feeBps === 0 || amount === 0n) return 0n;
  const target = amount * BigInt(feeBps);
  // Find the largest integer strictly below the fee threshold, then add one.
  return largestTrue(amount, (value) => value * BPS < target) + 1n;
}

export function checkState(state) {
  const { tokenInventory: x, realSolReserves: r, virtualSol: v, feeBps } = state;
  integer(x, "inventory");
  integer(r, "reserve");
  integer(v, "virtual reserve");
  assert(x > 0n && x <= SUPPLY, "invalid inventory");
  assert(v >= MIN_VIRTUAL_SOL && v <= MAX_VIRTUAL_SOL, "virtual reserve out of bounds");
  assert(r + v <= U64_MAX, "effective reserve overflow");
  assert([0, 100, 300].includes(feeBps), "unsupported fee");
  assert(x * (r + v) >= SUPPLY * v, "insolvent state");
}

function constraints(input, minOutput) {
  integer(input, "input");
  integer(minOutput, "minimum output");
  assert(input > 0n, "zero input");
}

export function quoteBuyOracle(state, grossLamports, minOutput = 1n) {
  checkState(state);
  constraints(grossLamports, minOutput);
  const { tokenInventory: x, realSolReserves: r, virtualSol: v } = state;
  const fee = feeOracle(grossLamports, state.feeBps);
  const netInput = grossLamports - fee;
  assert(netInput > 0n, "zero effective input");
  assert(r + v + netInput <= U64_MAX, "effective reserve overflow");
  const product = x * (r + v);
  const amountOut = largestTrue(x, (out) => (x - out) * (r + v + netInput) >= product);
  assert(amountOut > 0n && amountOut < x, "zero or exhausted output");
  assert(amountOut >= minOutput, "slippage");
  return {
    grossInput: grossLamports,
    netInput,
    fee,
    amountOut,
    nextTokenInventory: x - amountOut,
    nextRealSolReserves: r + netInput,
  };
}

export function quoteSellOracle(state, tokenAtoms, minOutput = 1n) {
  checkState(state);
  constraints(tokenAtoms, minOutput);
  const { tokenInventory: x, realSolReserves: r, virtualSol: v } = state;
  assert(tokenAtoms <= SUPPLY - x, "input exceeds circulating supply");
  const product = x * (r + v);
  // Deliberately search beyond actual R. The invariant must imply solvency;
  // clipping this limit to R would hide an incorrectly specified curve.
  const grossSol = largestTrue(r + v, (out) => (x + tokenAtoms) * (r + v - out) >= product);
  assert(grossSol <= r, "virtual reserve withdrawal");
  const fee = feeOracle(grossSol, state.feeBps);
  const amountOut = grossSol - fee;
  assert(amountOut > 0n, "zero output");
  assert(amountOut >= minOutput, "slippage");
  return {
    grossInput: tokenAtoms,
    netInput: tokenAtoms,
    fee,
    amountOut,
    nextTokenInventory: x + tokenAtoms,
    nextRealSolReserves: r - grossSol,
  };
}

export function nextState(state, quote) {
  return {
    ...state,
    tokenInventory: quote.nextTokenInventory,
    realSolReserves: quote.nextRealSolReserves,
  };
}

export function entitlementOracle(cumulativeFees, weightBps) {
  integer(cumulativeFees, "lifetime fees", U128_MAX);
  assert(Number.isInteger(weightBps) && weightBps > 0 && weightBps <= 10_000);
  const target = cumulativeFees * BigInt(weightBps);
  // JS bigint is unbounded: this intentionally exercises values whose naive
  // multiplication overflows the program's u128 representation.
  return largestTrue(cumulativeFees, (value) => value * BPS <= target);
}

export function claimOracle(cumulativeFees, weightBps, paid) {
  integer(paid, "paid", U128_MAX);
  const entitlement = entitlementOracle(cumulativeFees, weightBps);
  assert(paid <= entitlement, "overpaid recipient");
  return entitlement - paid;
}
