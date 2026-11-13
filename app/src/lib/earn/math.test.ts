import assert from "node:assert/strict";
import test from "node:test";
import { RATE_WINDOW_S, annualisedRate, cleanAmountInput, depositProblem, fmtAmount, fmtFeePct, fmtRate, managementFeeYearPct, maxInput, parseAmount, wadPct, withdrawPlan, withdrawProblem } from "./math.ts";

test("the 30-day rate from the vault's real share prices on 2026-10-14 reads 4.4%", () => {
  // Steakhouse Prime USDC, convertToAssets(1e18) at blocks 51,280,486 and 52,576,486 (timestamps 2,592,000 s apart)
  const rate = annualisedRate(1_040_432n, 1_044_155n, 1_791_942_319 - 1_789_350_319);
  assert.ok(rate !== null);
  assert.ok(Math.abs(rate - 0.043536) < 0.00001, String(rate));
  assert.equal(fmtRate(rate), "4.4%");
  assert.equal(RATE_WINDOW_S, 2_592_000);
});

test("a rate that cannot be told is null, and a falling share price is shown as negative", () => {
  assert.equal(annualisedRate(0n, 1n, 100), null);
  assert.equal(annualisedRate(1n, 0n, 100), null);
  assert.equal(annualisedRate(1n, 2n, 0), null);
  assert.equal(annualisedRate(1n, 2n, Number.NaN), null);
  const loss = annualisedRate(1_000_000n, 997_500n, RATE_WINDOW_S); // −0.25% in 30 days
  assert.equal(fmtRate(loss), "−3.0%");
  assert.equal(fmtRate(-0.0436), fmtRate(0.0436).replace(/^/, "−"));
  assert.equal(fmtRate(null), "—");
  assert.equal(fmtRate(0.0001), "0.0%");
});

test("fees read as people say them", () => {
  assert.equal(wadPct(0n), 0);
  assert.equal(wadPct(250_000_000_000_000_000n), 25);
  assert.equal(fmtFeePct(25), "25%");
  assert.equal(fmtFeePct(0), "0%");
  assert.equal(fmtFeePct(2.5), "2.5%");
  // Vault V2's cap: 5% a year expressed per second
  assert.ok(Math.abs(managementFeeYearPct(50_000_000_000_000_000n / 31_536_000n) - 5) < 0.0001);
});

test("the amount field keeps only what the asset can represent and refuses anything ambiguous", () => {
  assert.equal(cleanAmountInput("1.1234567", 6), "1.123456");
  assert.equal(cleanAmountInput("1,234.5", 6), "1234.5");
  assert.equal(cleanAmountInput("1e5", 6), "");
  assert.equal(cleanAmountInput("$12", 6), "12");
  assert.equal(parseAmount("1.5", 6), 1_500_000n);
  assert.equal(parseAmount("0.000001", 6), 1n);
  assert.equal(parseAmount("1.1234567", 6), null);
  assert.equal(parseAmount("", 6), null);
  assert.equal(parseAmount(".", 6), null);
  assert.equal(parseAmount("0", 6), null);
  assert.equal(parseAmount("abc", 6), null);
  assert.equal(parseAmount("1.2.3", 6), null);
});

test("amounts display rounded down, never above what is there", () => {
  assert.equal(fmtAmount(1_234_567_891n, 6), "1,234.56");
  assert.equal(fmtAmount(999_999_999n, 6), "999.99");
  assert.equal(fmtAmount(5_000n, 6), "<0.01");
  assert.equal(fmtAmount(0n, 6), "0.00");
  assert.equal(maxInput(1_234_567_891n, 6), "1234.567891");
  assert.equal(maxInput(0n, 6), "");
});

test("a deposit needs an amount within the wallet's USDC", () => {
  assert.equal(depositProblem({ amount: null, balance: 10n }), "Enter an amount");
  assert.equal(depositProblem({ amount: 5n, balance: undefined }), "Reading your balance…");
  assert.equal(depositProblem({ amount: 11n, balance: 10n }), "More than your USDC");
  assert.equal(depositProblem({ amount: 10n, balance: 10n }), null);
});

test("asking for the whole position redeems every share; less withdraws that exact amount", () => {
  const shares = 957_677_265_110_010_099_404n;
  const position = 999_999_999n;
  assert.deepEqual(withdrawPlan({ amount: position, shares, position }), { fn: "redeem", shares, assets: position });
  assert.deepEqual(withdrawPlan({ amount: position + 1n, shares, position }), { fn: "redeem", shares, assets: position });
  assert.deepEqual(withdrawPlan({ amount: 100_000_000n, shares, position }), { fn: "withdraw", assets: 100_000_000n });
  assert.equal(withdrawPlan({ amount: 1n, shares: 0n, position: 0n }), null);
  assert.equal(withdrawPlan({ amount: null, shares, position }), null);
});

test("a withdrawal needs a deposit and an amount within it", () => {
  assert.equal(withdrawProblem({ amount: 1n, shares: undefined, position: undefined }), "Reading your deposit…");
  assert.equal(withdrawProblem({ amount: 1n, shares: 0n, position: 0n }), "Nothing deposited");
  assert.equal(withdrawProblem({ amount: null, shares: 5n, position: 5n }), "Enter an amount");
  assert.equal(withdrawProblem({ amount: 6n, shares: 5n, position: 5n }), "More than your deposit");
  assert.equal(withdrawProblem({ amount: 5n, shares: 5n, position: 5n }), null);
});
