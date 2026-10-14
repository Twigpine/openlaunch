import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { BUY_PRESETS, SUGGESTED_BUY_USD, amountForUsd, defaultFirstBuy, gasReserveInQuote, suggestFirstBuy } from "./first-buy.ts";

const eth = { key: "eth" as const, decimals: 18, usd: null };
const usdg = { key: "usdg" as const, decimals: 6, usd: 1 };
const gitlawb = { key: "gitlawb" as const, decimals: 18, usd: 0.00002 };
const nvda = { key: "stock" as const, decimals: 18, usd: 223.05 };
const GAS = parseUnits("0.0015", 18); // the form's reserve: launch gas + buy gas
const base = { connected: true, declined: false, balanceFailed: false, parse: parseUnits };

test("default: the first preset for ETH, USDG and GITLAWB; $25 worth for a stock; nothing for a stock without a price", () => {
  assert.equal(defaultFirstBuy(eth), BUY_PRESETS.eth[0]);
  assert.equal(defaultFirstBuy(usdg), "25");
  assert.equal(defaultFirstBuy(gitlawb), "500000");
  assert.equal(defaultFirstBuy(nvda), "0.11", `${SUGGESTED_BUY_USD} / 223.05`);
  assert.equal(defaultFirstBuy({ ...nvda, usd: null }), null);
});

test("a stock nobody holds yet (issued false): nothing to suggest, wallet or not; an unknown issue state changes nothing", () => {
  const coin = { ...nvda, issued: false };
  assert.equal(defaultFirstBuy(coin), null, "so the form offers no \"suggest again\" either");
  assert.deepEqual(suggestFirstBuy({ ...base, quote: coin, connected: false, balance: undefined, nativeBalance: undefined, gasReserve: GAS }), { amount: null, reason: "not-issued" }, "before a wallet connects too: no provisional 0.11 COINc in the preview");
  assert.deepEqual(suggestFirstBuy({ ...base, quote: coin, balance: 0n, nativeBalance: GAS, gasReserve: GAS }), { amount: null, reason: "not-issued" }, "named for why, not as a short balance");
  assert.deepEqual(suggestFirstBuy({ ...base, quote: coin, balance: 0n, nativeBalance: GAS, gasReserve: GAS, declined: true }), { amount: null, reason: "declined" });
  for (const issued of [true, null, undefined]) {
    assert.equal(defaultFirstBuy({ ...nvda, issued }), "0.11", String(issued));
    assert.deepEqual(suggestFirstBuy({ ...base, quote: { ...nvda, issued }, connected: false, balance: undefined, nativeBalance: undefined, gasReserve: GAS }), { amount: "0.11", provisional: true }, String(issued));
  }
});

test("amountForUsd: short decimals parseUnits accepts, never more places than the quote has, null when it rounds away", () => {
  assert.equal(amountForUsd(25, 2500, 18), "0.01");
  assert.equal(amountForUsd(25, 1, 6), "25");
  assert.equal(amountForUsd(25, 0.00002, 18), "1250000");
  assert.equal(amountForUsd(25, 120000, 18), "0.00021");
  assert.equal(amountForUsd(25, 3, 0), "8", "a 0-decimal quote gets a whole number");
  assert.equal(amountForUsd(25, 100, 0), null, "a 0-decimal quote where $25 is less than one unit: no suggestion, not \"0\"");
  assert.equal(amountForUsd(25, 3000, 2), "0.01");
  assert.equal(amountForUsd(25, 30000, 2), null, "rounds to 0.00 at 2 decimals");
  assert.equal(amountForUsd(25, 1e12, 2), null, "rounds to nothing at 2 decimals");
  assert.equal(amountForUsd(0, 1, 6), null);
  assert.equal(amountForUsd(25, 0, 6), null);
  assert.equal(amountForUsd(Infinity, 1, 18), null, "non-finite usd never becomes \"Infinity\" for parseUnits");
  assert.equal(amountForUsd(NaN, 1, 18), null);
  assert.equal(amountForUsd(25, Infinity, 18), null);
  assert.equal(amountForUsd(25, NaN, 18), null);
  for (const [usd, dec] of [[2464.485, 18], [223.05, 18], [0.0000195, 18], [1, 6]] as const) {
    const a = amountForUsd(25, usd, dec)!;
    assert.ok(parseUnits(a, dec) > 0n, `parseUnits accepts ${a}`);
  }
});

test("suggestFirstBuy (ETH quote): selected from the start; a connected wallet's balance can only take it away", () => {
  const enough = parseUnits("0.02", 18);
  const ethIn = (balance: bigint | undefined, more = {}) => suggestFirstBuy({ ...base, quote: eth, balance, nativeBalance: balance, gasReserve: GAS, ...more });
  assert.deepEqual(ethIn(undefined, { connected: false }), { amount: "0.01", provisional: true }, "no wallet yet: the default is shown as selected");
  assert.deepEqual(ethIn(undefined), { amount: "0.01", provisional: true }, "wallet connected, balance still loading: keep it, no flicker");
  assert.deepEqual(ethIn(undefined, { balanceFailed: true }), { amount: null, reason: "unknown-balance" }, "the read failed: drop it so it cannot block the launch");
  assert.deepEqual(ethIn(enough), { amount: "0.01", provisional: false }, "confirmed against the balance");
  assert.deepEqual(ethIn(parseUnits("0.0114", 18)), { amount: null, reason: "insufficient" }, "covers the amount and the buy's gas but not the launch's");
  assert.deepEqual(ethIn(parseUnits("0.0115", 18)), { amount: "0.01", provisional: false }, "exactly amount + both reserves");
  assert.deepEqual(ethIn(enough, { declined: true }), { amount: null, reason: "declined" });
  assert.deepEqual(ethIn(undefined, { connected: false, declined: true }), { amount: null, reason: "declined" }, "cleared stays cleared without a wallet too");
  assert.deepEqual(suggestFirstBuy({ ...base, quote: { ...nvda, usd: null }, balance: enough, nativeBalance: enough, gasReserve: 0n }), { amount: null, reason: "no-price" });
});

test("suggestFirstBuy (ERC-20 quote): the token balance must cover the amount and the native balance must cover the gas", () => {
  const usdgIn = (balance: bigint | undefined, nativeBalance: bigint | undefined) => suggestFirstBuy({ ...base, quote: usdg, balance, nativeBalance, gasReserve: GAS });
  assert.deepEqual(usdgIn(parseUnits("25", 6), GAS), { amount: "25", provisional: false }, "exact token balance is enough; gas is separate");
  assert.deepEqual(usdgIn(parseUnits("24.99", 6), GAS), { amount: null, reason: "insufficient" });
  assert.deepEqual(usdgIn(parseUnits("100", 6), GAS - 1n), { amount: null, reason: "no-gas" }, "tokens, but one wei short of gas for the launch, the approvals and the swap");
  assert.deepEqual(usdgIn(parseUnits("100", 6), GAS), { amount: "25", provisional: false }, "exactly the reserve");
  assert.deepEqual(usdgIn(parseUnits("100", 6), undefined), { amount: "25", provisional: true }, "native balance still loading: keep it");
  assert.deepEqual(suggestFirstBuy({ ...base, quote: usdg, balance: undefined, nativeBalance: GAS, gasReserve: GAS, balanceFailed: true }), { amount: null, reason: "unknown-balance" }, "token balance read failed: drop it");
  assert.deepEqual(suggestFirstBuy({ ...base, quote: nvda, balance: parseUnits("1", 18), nativeBalance: GAS, gasReserve: GAS }), { amount: "0.11", provisional: false });
});

test("suggestFirstBuy (quote that IS the gas token, USDC on Arc): one balance pays the buy and the gas", () => {
  // Arc's native asset is USDC at 18 decimals; the same balance is the 6-decimal ERC-20 the pool is quoted in
  const usdc = { key: "usdc" as const, decimals: 6, usd: 1 };
  const reserve = parseUnits("0.1", 18); // 0.1 USDC of gas, in native wei
  const arcIn = (usdcBalance: bigint) => suggestFirstBuy({ ...base, quote: usdc, balance: usdcBalance, nativeBalance: usdcBalance * 10n ** 12n, gasReserve: reserve, sharesGasBalance: true });
  assert.equal(gasReserveInQuote(reserve, 6), parseUnits("0.1", 6), "the reserve is converted into the quote's own units");
  assert.equal(gasReserveInQuote(reserve, 18), reserve);
  assert.deepEqual(arcIn(parseUnits("25.1", 6)), { amount: "25", provisional: false }, "exactly amount + reserve");
  assert.deepEqual(arcIn(parseUnits("25.09", 6)), { amount: null, reason: "insufficient" }, "the ERC-20 balance alone would cover the buy, but nothing would be left for gas");
  assert.deepEqual(arcIn(parseUnits("25", 6)), { amount: null, reason: "insufficient" });
  // the same balances for a quote that does NOT share the gas balance (USDG) pass, since gas comes from a separate asset
  assert.deepEqual(suggestFirstBuy({ ...base, quote: usdg, balance: parseUnits("25", 6), nativeBalance: reserve, gasReserve: reserve }), { amount: "25", provisional: false });
});
