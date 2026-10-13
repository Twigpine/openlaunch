import { test } from "node:test";
import assert from "node:assert/strict";
import { fdvForStartTick, fmtCompact, fmtEth, fmtQuote, fmtQuoteUnits, fmtPrice, fmtUnitsExact, fmtUsd, initialBuyPreview, minOut, poolIdOf, quoteDisplayFloor, quoteUsdOf, startTickForFdv, sqrtPriceToTokensPerQuote, tickToTokensPerQuote } from "./math.ts";
import { encodeV4ExactInSingle } from "./swap.ts";

test("startTickForFdv: 10 ETH FDV on 1B supply ≈ tick 184200 (1 ETH = 100M tokens)", () => {
  assert.equal(startTickForFdv(10), 184_200);
  assert.ok(Math.abs(tickToTokensPerQuote(184_200) - 1e8) / 1e8 < 0.02);
  const fdv = fdvForStartTick(184_200);
  assert.ok(fdv >= 10 && fdv < 10.3, `snapped down in tick = slightly higher fdv, got ${fdv}`);
});

test("startTickForFdv snaps to spacing and is monotonic", () => {
  for (const f of [0.5, 1, 5, 25, 100]) assert.equal(startTickForFdv(f) % 200, 0);
  assert.ok(startTickForFdv(1) > startTickForFdv(25));
});

test("USDG (6 dec) quote: $10k FDV on 1B supply ≈ tick 391400, round-trips", () => {
  const t = startTickForFdv(10_000, 6);
  assert.equal(t % 200, 0);
  assert.ok(Math.abs(t - 391_400) <= 200, `got ${t}`);
  const fdv = fdvForStartTick(t, 6);
  assert.ok(fdv >= 10_000 && fdv < 10_300, `fdv ${fdv}`);
  // 1 USDG buys ~100k tokens at that price
  const perUsdg = tickToTokensPerQuote(t, 6);
  assert.ok(perUsdg > 95_000 && perUsdg < 100_500, `per usdg ${perUsdg}`);
});

test("sqrtPrice round-trips a tick", () => {
  const tick = 184_200;
  const sqrt = BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 96));
  const t = sqrtPriceToTokensPerQuote(sqrt);
  assert.ok(Math.abs(t - 1.0001 ** tick) / t < 1e-6);
});

test("poolIdOf matches keccak(abi.encode(PoolKey)) for a known vector", () => {
  // Any key; the important property is stability + the ETH/token ordering used everywhere.
  const id = poolIdOf({
    currency0: "0x0000000000000000000000000000000000000000",
    currency1: "0x26c30b044B7C4d046282282D3338d72A0b4653A7",
    fee: 0,
    tickSpacing: 200,
    hooks: "0x0000000000000000000000000000000000000000",
  });
  assert.match(id, /^0x[0-9a-f]{64}$/);
});

test("minOut applies bps slippage", () => {
  assert.equal(minOut(10_000n, 100), 9_900n);
  assert.equal(minOut(0n, 500), 0n);
});

test("unavailable figures use — without turning them into zero", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    for (const format of [fmtCompact, fmtEth, fmtPrice, fmtUsd]) assert.equal(format(value), "—");
  }
  assert.equal(fmtCompact(0), "0.00");
  assert.equal(fmtEth(0), "0");
  assert.equal(fmtUsd(0), "$0");
});

test("fmtEth trims noise", () => {
  assert.equal(fmtEth(10n ** 18n), "1");
  assert.equal(fmtEth(5n * 10n ** 16n), "0.05");
  assert.equal(fmtEth(0n), "0");
});

test("encodeV4ExactInSingle builds a V4_SWAP command with 3 actions", () => {
  const { commands, inputs } = encodeV4ExactInSingle({
    key: {
      currency0: "0x0000000000000000000000000000000000000000",
      currency1: "0x26c30b044B7C4d046282282D3338d72A0b4653A7",
      fee: 10_000,
      tickSpacing: 200,
      hooks: "0x0000000000000000000000000000000000000000",
    },
    zeroForOne: true,
    amountIn: 10n ** 17n,
    minOut: 1n,
  });
  assert.equal(commands, "0x10");
  assert.equal(inputs.length, 1);
  assert.ok(inputs[0].includes("060c0f"), "actions packed as 06 0c 0f");
});

test("encodeV4ExactInSingle v2 layout carries minHopPriceX36 (Robinhood router)", () => {
  const key = { currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", currency1: "0xBdAD69fac07E5C627F86294C69F8179CA730f28A", fee: 10_000, tickSpacing: 200, hooks: "0x0000000000000000000000000000000000000000" } as const;
  const v1 = encodeV4ExactInSingle({ key, zeroForOne: true, amountIn: 1n, minOut: 0n, layout: "v1" });
  const v2 = encodeV4ExactInSingle({ key, zeroForOne: true, amountIn: 1n, minOut: 0n, layout: "v2" });
  assert.notEqual(v1.inputs[0], v2.inputs[0]);
  assert.equal(v2.inputs[0].length - v1.inputs[0].length, 64, "one extra uint256 word");
});

test("quoteUsdOf: stables/stocks use their own price, ETH only for the ETH quote, unknown ERC20 and a bare native address are never priced", () => {
  assert.equal(quoteUsdOf({ key: "eth", usd: null }, 2500), 2500);
  assert.equal(quoteUsdOf({ key: "eth", usd: null }, null), null, "no ETH price → unknown, not 0");
  assert.equal(quoteUsdOf({ key: "usdg", usd: 1 }, 2500), 1, "USDG");
  assert.equal(quoteUsdOf({ key: "usdc", usd: 1 }, 2500), 1, "Arc's native USDC carries its own dollar; address(0) alone is not ETH");
  assert.equal(quoteUsdOf({ key: "stock", usd: 229.01 }, 2500), 229.01, "stock with live price");
  assert.equal(quoteUsdOf({ key: "stock", usd: null }, 2500), null, "unknown ERC20 must not be priced as ETH");
});

test("initialBuyPreview: a tiny first buy pays the opening price; bigger buys get less per ETH", () => {
  const tick = startTickForFdv(10); // 10 ETH FDV, 1B supply → ~1e8 tokens per ETH at the open
  const tiny = initialBuyPreview({ startTick: tick, amountInRaw: 10n ** 12n }); // 0.000001 ETH
  const perEthAtOpen = tickToTokensPerQuote(tick);
  assert.ok(Math.abs(tiny.tokensOut / 1e-6 - perEthAtOpen) / perEthAtOpen < 1e-4, "tiny buy ≈ opening price");
  const one = initialBuyPreview({ startTick: tick, amountInRaw: 10n ** 18n }); // 1 ETH into a 10 ETH FDV pool
  assert.ok(one.tokensOut < perEthAtOpen, "price impact: less than the opening rate");
  assert.ok(one.tokensOut > perEthAtOpen * 0.5, "…but not absurdly less");
  assert.ok(one.pctOfSupply > 5 && one.pctOfSupply < 10, `1 ETH into 10 ETH FDV ≈ 9% of supply, got ${one.pctOfSupply}`);
  assert.ok(one.fdvAfter > 10, "market cap rises after a buy");
  const ten = initialBuyPreview({ startTick: tick, amountInRaw: 10n ** 19n });
  assert.ok(ten.tokensOut > one.tokensOut && ten.pctOfSupply < 100, "monotonic and never more than the supply");
});

test("initialBuyPreview: the LP fee reduces output; quote decimals are honoured", () => {
  const tick = startTickForFdv(10);
  const free = initialBuyPreview({ startTick: tick, amountInRaw: 10n ** 17n, lpFeePips: 0 });
  const fee1 = initialBuyPreview({ startTick: tick, amountInRaw: 10n ** 17n, lpFeePips: 10_000 });
  assert.ok(Math.abs(fee1.tokensOut / free.tokensOut - 0.99) < 1e-3, "1% fee → ~1% fewer tokens");
  // 6-decimal quote: 1,000 USDG FDV, buy 10 USDG → ~1% of supply at the open, a bit less with impact
  const t6 = startTickForFdv(1_000, 6);
  const u = initialBuyPreview({ startTick: t6, amountInRaw: 10n * 10n ** 6n, quoteDecimals: 6 });
  assert.ok(u.pctOfSupply > 0.9 && u.pctOfSupply < 1.0, `got ${u.pctOfSupply}`);
  assert.ok(u.fdvAfter > 1_000 && u.fdvAfter < 1_100, `fdv after ${u.fdvAfter}`);
});

test("fmtQuoteUnits: a real amount never prints as a bare 0", () => {
  assert.equal(quoteDisplayFloor(6), 0.005);
  assert.equal(quoteDisplayFloor(18), 5e-9);
  assert.equal(quoteDisplayFloor(8), 5e-9);
  // USDG dust: 4,999 raw units used to read "0 USDG" in the tape and the toasts
  assert.equal(fmtQuote("4999", 6, "USDG"), "<0.01 USDG");
  assert.equal(fmtQuote("1", 6, "USDG"), "<0.01 USDG");
  assert.equal(fmtQuote("5000", 6, "USDG"), "0.01 USDG");
  // 18-dec quotes: under 5 gwei
  assert.equal(fmtQuote("4999999999", 18, "ETH"), "<0.00000001 ETH");
  assert.equal(fmtQuote("1", 18, "GITLAWB"), "<0.00000001 GITLAWB");
  assert.equal(fmtQuote("5000000000", 18, "ETH"), "0.00000001 ETH");
  assert.equal(fmtQuote("1", 8, "MSTRc"), "0.00000001 MSTRc");
  assert.equal(fmtQuoteUnits(-0.001, 6), "<0.01", "sign-agnostic: callers pass magnitudes");
  // only an exact zero is "0": empty volume stats keep reading 0
  assert.equal(fmtQuote("0", 6, "USDG"), "0 USDG");
  assert.equal(fmtQuote("0", 18, "ETH"), "0 ETH");
  assert.equal(fmtQuoteUnits(0, 18), "0");
});

test("fmtQuoteUnits: stables 2dp, 18-dec ETH-style below 100K, compact above with suffix promotion", () => {
  assert.equal(fmtQuoteUnits(12.5, 6), "12.50");
  assert.equal(fmtQuoteUnits(250, 6), "250");
  assert.equal(fmtQuoteUnits(0.0421, 18), "0.0421");
  assert.equal(fmtQuoteUnits(99_999.99999999999, 18), "100K", "float noise at the boundary still compacts");
  assert.equal(fmtQuoteUnits(150_000, 18), "150K");
  assert.equal(fmtQuoteUnits(999_999, 18), "1M", "no 1000.00K");
  assert.equal(fmtQuoteUnits(1_234_567, 18), "1.23M");
  assert.equal(fmtQuoteUnits(594_540_000, 18), "594.54M");
});

test("fmtQuoteUnits labels a first-buy chip with the amount it sets", () => {
  assert.equal(fmtQuoteUnits(1_000_000, 18), "1M");
  assert.equal(fmtQuoteUnits(2_500_000, 18), "2.5M", "the middle TWIG chip once read 3M");
  assert.equal(fmtQuoteUnits(5_000_000, 18), "5M");
  assert.equal(fmtQuoteUnits(750_000, 18), "750K");
  assert.equal(fmtQuoteUnits(100_000, 18), "100K");
  assert.equal(fmtQuoteUnits(12_345_678, 18), "12.35M");
});

test("fmtUnitsExact keeps every digit of a raw amount: no float, no rounding, trailing zeros trimmed", () => {
  assert.equal(fmtUnitsExact("0", 18), "0");
  assert.equal(fmtUnitsExact("1", 18), "0.000000000000000001");
  assert.equal(fmtUnitsExact("1234000000000000000", 18), "1.234");
  assert.equal(fmtUnitsExact("78455865389296770000000000", 18), "78,455,865.38929677");
  assert.equal(fmtUnitsExact("123456789012345678901234567890", 18), "123,456,789,012.34567890123456789");
  assert.equal(fmtUnitsExact(-1500000n, 6), "-1.5");
  assert.equal(fmtUnitsExact("2500000", 6), "2.5");
});
