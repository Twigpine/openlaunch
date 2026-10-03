import assert from "node:assert/strict";
import test from "node:test";
import { parseUnits } from "viem";
import { requiredTradeNativeBalance, tradeGasStatus } from "./trade-gas.ts";
import { NATIVE, SWAP_GAS_RESERVE_WEI, quoteInfo, sharesGasBalance } from "./config.ts";

test("native buys keep their amount plus the existing chain gas reserve", () => {
  for (const chain of ["base", "robinhood", "arc"] as const) {
    const quote = quoteInfo(chain, NATIVE);
    const amountIn = parseUnits("1", quote.decimals);
    assert.equal(requiredTradeNativeBalance({ amountIn, spendsNativeBalance: true, quoteDecimals: quote.decimals, reserveWei: SWAP_GAS_RESERVE_WEI[chain] }), amountIn + SWAP_GAS_RESERVE_WEI[chain]);
  }
});

test("Arc USDC buys convert six-decimal spending to the same native gas balance exactly once", () => {
  const quote = quoteInfo("arc", "0x3600000000000000000000000000000000000000");
  assert.equal(sharesGasBalance("arc", quote), true);
  const required = requiredTradeNativeBalance({ amountIn: parseUnits("1", 6), spendsNativeBalance: true, quoteDecimals: quote.decimals, reserveWei: SWAP_GAS_RESERVE_WEI.arc });
  assert.equal(required, parseUnits("1.2", 18));
  assert.equal(tradeGasStatus(parseUnits("1", 18), false, required), "insufficient");
  assert.equal(tradeGasStatus(required, false, required), "ready", "one gas reserve, not two");
  assert.equal(tradeGasStatus(required - 1n, false, required), "insufficient");
});

test("ERC-20 buys and all sells need only the native gas reserve, independently of token decimals", () => {
  for (const chain of ["base", "robinhood", "arc"] as const) {
    for (const quoteDecimals of [6, 18, 24]) {
      assert.equal(requiredTradeNativeBalance({ amountIn: parseUnits("100", quoteDecimals), spendsNativeBalance: false, quoteDecimals, reserveWei: SWAP_GAS_RESERVE_WEI[chain] }), SWAP_GAS_RESERVE_WEI[chain]);
    }
  }
});

test("pending or failed gas reads fail closed, including an errored refetch with stale data", () => {
  assert.equal(tradeGasStatus(undefined, false, 10n), "loading");
  assert.equal(tradeGasStatus(undefined, true, 10n), "error");
  assert.equal(tradeGasStatus(100n, true, 10n), "error");
  assert.equal(tradeGasStatus(0n, false, 10n), "insufficient");
  assert.equal(tradeGasStatus(10n, false, 10n), "ready");
  assert.equal(requiredTradeNativeBalance({ amountIn: null, spendsNativeBalance: true, quoteDecimals: 6, reserveWei: 10n }), 10n);
});
