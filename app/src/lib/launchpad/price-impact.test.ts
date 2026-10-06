import { test } from "node:test";
import assert from "node:assert/strict";
import { IMPACT_CONFIRM, IMPACT_WARN, fmtImpact, impactLevel, priceImpact, spotPrice1Per0 } from "./price-impact.ts";

/** sqrtPriceX96 for a currency1-per-currency0 price, exact enough for these checks. */
const sqrtFor = (price: number) => BigInt(Math.round(Math.sqrt(price) * 2 ** 48)) * 2n ** 48n;

/**
 * A constant-product pool (x·y = k) with the fee taken from the input: the exact output Uniswap's math gives for
 * full-range liquidity, which is what a fresh openlaunch pool is around the starting price.
 */
function cpOut(reserveIn: number, reserveOut: number, amountIn: number, feePips: number) {
  const inAfterFee = amountIn * (1 - feePips / 1e6);
  return (reserveOut * inAfterFee) / (reserveIn + inAfterFee);
}

test("spot price comes back from sqrtPriceX96", () => {
  assert.ok(Math.abs(spotPrice1Per0(sqrtFor(1e9)) / 1e9 - 1) < 1e-9);
  assert.equal(spotPrice1Per0(2n ** 96n), 1);
});

test("a buy's impact matches the constant-product curve, fee excluded", () => {
  // 10 ETH and 10B tokens in the pool: 1e9 tokens per ETH
  const x = 10e18, y = 10e27;
  for (const [amount, expected] of [[0.01e18, 0.001 / 1.001], [1e18, 1 / 11], [5e18, 5 / 15]] as const) {
    for (const fee of [0, 10_000, 30_000]) {
      const out = cpOut(x, y, amount, fee);
      const impact = priceImpact({ sqrtPriceX96: sqrtFor(y / x), amountIn: BigInt(amount), amountOut: BigInt(Math.floor(out)), zeroForOne: true, feePips: fee })!;
      // with the fee, the effective input is smaller, so the impact is a little smaller than the no-fee figure
      const inAfter = amount * (1 - fee / 1e6);
      const exact = inAfter / (x + inAfter);
      assert.ok(Math.abs(impact - exact) < 1e-6, `${amount}/${fee}: ${impact} vs ${exact}`);
      if (fee === 0) assert.ok(Math.abs(impact - expected) < 1e-6);
    }
  }
});

test("a sell's impact uses the inverse price", () => {
  const x = 10e18, y = 10e27;
  const amount = 1e27; // sell a tenth of the pool's tokens
  const out = cpOut(y, x, amount, 10_000);
  const impact = priceImpact({ sqrtPriceX96: sqrtFor(y / x), amountIn: BigInt(amount), amountOut: BigInt(Math.floor(out)), zeroForOne: false, feePips: 10_000 })!;
  const inAfter = amount * 0.99;
  assert.ok(Math.abs(impact - inAfter / (y + inAfter)) < 1e-6);
});

test("rounding above the ideal reads as zero, never negative; nonsense inputs read as unknown", () => {
  assert.equal(priceImpact({ sqrtPriceX96: 2n ** 96n, amountIn: 1000n, amountOut: 1001n, zeroForOne: true, feePips: 0 }), 0);
  assert.equal(priceImpact({ sqrtPriceX96: 0n, amountIn: 1000n, amountOut: 900n, zeroForOne: true, feePips: 0 }), null);
  assert.equal(priceImpact({ sqrtPriceX96: 2n ** 96n, amountIn: 0n, amountOut: 0n, zeroForOne: true, feePips: 0 }), null);
  assert.equal(priceImpact({ sqrtPriceX96: 2n ** 96n, amountIn: 10n, amountOut: 5n, zeroForOne: true, feePips: 1_000_000 }), null);
  assert.equal(priceImpact({ sqrtPriceX96: 2n ** 96n, amountIn: 10n, amountOut: 0n, zeroForOne: true, feePips: 0 }), 1, "nothing back is the whole price");
});

test("levels: amber from 5%, a second tap from 15%", () => {
  assert.equal(impactLevel(0.049), "low");
  assert.equal(impactLevel(IMPACT_WARN), "warn");
  assert.equal(impactLevel(0.149), "warn");
  assert.equal(impactLevel(IMPACT_CONFIRM), "confirm");
});

test("impact reads in sensible precision", () => {
  assert.equal(fmtImpact(0.00004), "<0.01%");
  assert.equal(fmtImpact(0.0042), "0.42%");
  assert.equal(fmtImpact(0.042), "4.2%");
  assert.equal(fmtImpact(0.374), "37%");
  assert.equal(fmtImpact(1), "100%");
});
