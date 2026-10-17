import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { claimableFees, feeEntitlement, FIXED_SUPPLY, formatAmount, MAX_VIRTUAL_SOL, MIN_VIRTUAL_SOL, minimumAfterSlippage, parseAmount, quoteBuy, quoteSell, U64_MAX, U128_MAX, validateCurve, type CurveState } from "../src/math.ts";
// Independent oracle maintained outside SDK: binary searches the invariant rather than using quotient formulas.
// @ts-expect-error Deliberately dependency-free JavaScript reference implementation.
import { quoteBuyOracle, quoteSellOracle } from "../../../../packages/solana-model/oracle.mjs";

const initial = (feeBps = 100): CurveState => ({ tokenInventory: FIXED_SUPPLY, realSolReserves: 0n, virtualSol: 30_000_000_000n, feeBps });
type Golden = { name: string; side: "buy" | "sell"; state: { tokenInventory: string; realSolReserves: string; virtualSol: string; feeBps: number }; input: string; minOutput: string; expected: Record<string, string> };
const vectors = JSON.parse(readFileSync(new URL("../../../../packages/solana-model/golden-vectors.json", import.meta.url), "utf8")) as Golden[];
for (const vector of vectors) test(`independent golden: ${vector.name}`, () => {
  const state = { ...vector.state, tokenInventory: BigInt(vector.state.tokenInventory), realSolReserves: BigInt(vector.state.realSolReserves), virtualSol: BigInt(vector.state.virtualSol) };
  const result = (vector.side === "buy" ? quoteBuy : quoteSell)(state, BigInt(vector.input), BigInt(vector.minOutput));
  for (const [key, value] of Object.entries(vector.expected)) assert.equal(result[key as keyof typeof result], BigInt(value), key);
});

test("12,000 differential trades match independent binary-search oracle", () => {
  let seed = 29103;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (const feeBps of [0, 100, 300]) {
    let state = initial(feeBps);
    for (let i = 0; i < 4000; i++) {
      const sell = random() % 2 === 0 && state.tokenInventory < FIXED_SUPPLY;
      const circulating = FIXED_SUPPLY - state.tokenInventory;
      const input = sell ? circulating * BigInt(random() % 1000 + 1) / 1001n : BigInt(random() % 1_000_000_000 + 10_000);
      let quote;
      try { quote = (sell ? quoteSell : quoteBuy)(state, input); }
      catch { assert.throws(() => (sell ? quoteSellOracle : quoteBuyOracle)(state, input)); continue; }
      const oracle = (sell ? quoteSellOracle : quoteBuyOracle)(state, input);
      for (const key of ["amountOut", "fee", "nextTokenInventory", "nextRealSolReserves"] as const) assert.equal(quote[key], oracle[key]);
      state = { ...state, tokenInventory: quote.nextTokenInventory, realSolReserves: quote.nextRealSolReserves };
      validateCurve(state);
    }
  }
});
test("integer boundaries, slippage and underfunded state reject", () => {
  assert.throws(() => quoteBuy(initial(), 0n));
  assert.throws(() => quoteBuy(initial(), 1n));
  assert.throws(() => quoteBuy(initial(0), U64_MAX));
  assert.doesNotThrow(() => quoteBuy({ ...initial(300), virtualSol: MIN_VIRTUAL_SOL }, U64_MAX));
  assert.throws(() => quoteBuy(initial(), U64_MAX + 1n));
  assert.throws(() => quoteBuy({ ...initial(), virtualSol: MAX_VIRTUAL_SOL + 1n }, 1000n));
  assert.throws(() => quoteBuy({ ...initial(), virtualSol: MIN_VIRTUAL_SOL - 1n }, 1000n));
  assert.throws(() => quoteBuy(initial(), 10000n, FIXED_SUPPLY));
  assert.throws(() => quoteSell(initial(), 1n));
  assert.throws(() => quoteSell({ ...initial(), tokenInventory: FIXED_SUPPLY / 2n }, 1n));
  assert.throws(() => quoteBuy({ ...initial(), feeBps: 99 }, 10000n));
});
test("lifetime fees use full u128 without overflow and cumulative claims leave <N dust", () => {
  for (const total of [1n, 17n, U64_MAX + 50000n, U128_MAX]) {
    const amounts = [3333, 3333, 3334].map((w) => feeEntitlement(total, w));
    const dust = total - amounts.reduce((sum, amount) => sum + amount, 0n);
    assert.ok(dust >= 0n && dust < 3n);
    assert.equal(claimableFees(total, 3333, amounts[0]), 0n);
  }
  assert.throws(() => feeEntitlement(U128_MAX + 1n, 10000));
  assert.throws(() => claimableFees(1n, 10000, 2n));
});
test("user amount handling never loses decimals or accepts exponent notation", () => {
  assert.equal(parseAmount("1.000000001", 9), 1_000_000_001n);
  assert.equal(parseAmount("18446744073.709551615", 9), U64_MAX);
  assert.equal(formatAmount(U64_MAX, 9), "18446744073.709551615");
  assert.equal(formatAmount(1n, 6), "0.000001");
  for (const value of ["1e9", "-1", " 1", "+1", "1.", ".5", "01", "0.0000000001", "NaN", "Infinity"]) assert.throws(() => parseAmount(value, 9), value);
  assert.equal(minimumAfterSlippage(1000n, 50), 995n);
  assert.throws(() => minimumAfterSlippage(1n, 50));
});
