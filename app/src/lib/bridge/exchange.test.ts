import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "viem";
import { EXCHANGE_NETWORKS, EXCHANGE_WATCH_MS, exchangeGuideOpen, exchangeNeedsGas, exchangeNext, findExchangeArrivals, nextExchangeBaseline, parseExchangeWatch, readExchangeHoldings, serializeExchangeWatch, type ExchangeArrival } from "./exchange.ts";
import type { BridgeHolding } from "./fund.ts";
import { ARBITRUM_USDC, BASE_USDC, BRIDGE_SEND_ASSETS, ETHEREUM_USDC, OPTIMISM_USDC, isBridgeAssetSupported, type BridgeChainId } from "./types.ts";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const eth = (chainId: BridgeChainId, value: number): BridgeHolding => ({ chainId, asset: "ETH", amount: BigInt(Math.round(value * 1e6)) * 10n ** 12n, decimals: 18 });
const usdc = (chainId: BridgeChainId, value: number): BridgeHolding => ({ chainId, asset: "USDC", amount: BigInt(Math.round(value * 1e6)), decimals: 6 });

test("withdrawals are pointed only at networks the bridge sends ETH and USDC from, Base first", () => {
  assert.deepEqual([...EXCHANGE_NETWORKS], [8453, 1, 42161, 10]);
  // each sends ETH and USDC, so every route out of it is one of the send-by-receive pairs the bridge checks live
  for (const id of EXCHANGE_NETWORKS) {
    assert.deepEqual([...BRIDGE_SEND_ASSETS[id]], ["ETH", "USDC"], `${id} sends ETH and USDC`);
    for (const asset of BRIDGE_SEND_ASSETS[id]) assert.ok(isBridgeAssetSupported(id, asset, "input"));
  }
  // Robinhood Chain, Arc and Elysium are never suggested as a withdrawal network
  for (const id of [4663, 5042, 99901]) assert.ok(!(EXCHANGE_NETWORKS as readonly number[]).includes(id), String(id));
});

test("the watch reads ETH and Circle's USDC on those four networks only, each read standing alone", async () => {
  const native: number[] = [];
  const tokens: string[] = [];
  const holdings = await readExchangeHoldings({
    native: async (chainId) => { native.push(chainId); if (chainId === 1) throw new Error("rpc down"); return 10n ** 16n; },
    token: async (chainId, token) => { tokens.push(`${chainId}:${token}`); return 5_000_000n; },
  }, WALLET);
  assert.deepEqual([...native].sort(), [1, 10, 42161, 8453].sort());
  assert.deepEqual(tokens.sort(), [`8453:${BASE_USDC}`, `1:${ETHEREUM_USDC}`, `42161:${ARBITRUM_USDC}`, `10:${OPTIMISM_USDC}`].sort(), "never USDC.e");
  // Ethereum's ETH did not answer: it is left out, never counted as empty, and its USDC still counts
  assert.equal(holdings.find((h) => h.chainId === 1 && h.asset === "ETH"), undefined);
  assert.equal(holdings.find((h) => h.chainId === 1 && h.asset === "USDC")?.amount, 5_000_000n);
  assert.equal(holdings.length, 7);
});

test("the baseline starts at what is already there and only ever comes down", () => {
  const first = nextExchangeBaseline({}, [usdc(42161, 40), eth(42161, 0.01)]);
  assert.deepEqual(first, { "42161:USDC": 40_000_000n, "42161:ETH": 10n ** 16n });
  // a rise keeps the baseline, a drop lowers it, and a network read for the first time starts where it stands
  const next = nextExchangeBaseline(first, [usdc(42161, 65), eth(42161, 0.004), usdc(10, 3)]);
  assert.deepEqual(next, { "42161:USDC": 40_000_000n, "42161:ETH": 4n * 10n ** 15n, "10:USDC": 3_000_000n });
  // a network that did not answer keeps its baseline
  assert.deepEqual(nextExchangeBaseline(next, []), next);
});

test("an arrival is a rise worth a bridge fee, with the ETH beside it as its gas", () => {
  const baseline = nextExchangeBaseline({}, [usdc(42161, 40), eth(42161, 0), usdc(8453, 2), eth(8453, 0.01), usdc(10, 0), eth(10, 0)]);
  // funds already there never count
  assert.deepEqual(findExchangeArrivals(baseline, [usdc(42161, 40), eth(42161, 0), usdc(8453, 2), eth(8453, 0.01)]), []);
  const now = [usdc(42161, 290), eth(42161, 0), usdc(8453, 2.5), eth(8453, 0.01), usdc(10, 0), eth(10, 0.0002)];
  // 250 USDC on Arbitrum with no ETH there; half a dollar on Base and 0.0002 ETH on Optimism are dust
  assert.deepEqual(findExchangeArrivals(baseline, now), [{ chainId: 42161, asset: "USDC", amount: 250_000_000n, decimals: 6, gas: 0n }]);
  // a network read for the first time is a baseline, not an arrival
  assert.deepEqual(findExchangeArrivals(nextExchangeBaseline(baseline, [usdc(1, 500)]), [usdc(1, 500)]), []);
});

test("a token comes before the ETH that landed beside it, and networks keep their order", () => {
  const baseline = nextExchangeBaseline({}, [usdc(42161, 0), eth(42161, 0), usdc(8453, 0), eth(1, 0)]);
  const arrivals = findExchangeArrivals(baseline, [eth(42161, 0.004), usdc(42161, 250), eth(1, 0.05), usdc(8453, 10)]);
  assert.deepEqual(arrivals.map((a) => `${a.chainId}:${a.asset}`), ["8453:USDC", "1:ETH", "42161:USDC", "42161:ETH"]);
  assert.equal(arrivals[2].gas, 4n * 10n ** 15n, "the withdrawn ETH pays the USDC's gas");
  assert.equal(arrivals[3].gas, null, "ETH needs no gas of its own");
  // Base's USDC with no ETH read on Base: unknown, so no warning
  assert.equal(arrivals[0].gas, null);
  assert.deepEqual(arrivals.map(exchangeNeedsGas), [false, false, false, false]);
  assert.equal(exchangeNeedsGas({ chainId: 10, asset: "USDC", amount: 1n, decimals: 6, gas: 0n }), true);
});

test("an arrival opens the bridge from where it landed, or needs nothing when it landed where it is wanted", () => {
  const onArbitrum: ExchangeArrival = { chainId: 42161, asset: "USDC", amount: 25_500_000n, decimals: 6, gas: 0n };
  assert.deepEqual(exchangeNext(onArbitrum, 5042), { kind: "bridge", originChainId: 42161, originAsset: "USDC", amount: "25.5" });
  // ETH is left for the sender to size, since some of it pays the gas
  assert.deepEqual(exchangeNext({ chainId: 1, asset: "ETH", amount: 5n * 10n ** 16n, decimals: 18, gas: null }, 4663), { kind: "bridge", originChainId: 1, originAsset: "ETH", amount: "" });
  assert.deepEqual(exchangeNext({ chainId: 8453, asset: "USDC", amount: 100_000_000n, decimals: 6, gas: null }, 8453), { kind: "ready" });
  assert.deepEqual(exchangeNext({ chainId: 8453, asset: "USDC", amount: 100_000_000n, decimals: 6, gas: null }, 99901), { kind: "bridge", originChainId: 8453, originAsset: "USDC", amount: "100" });
});

test("a saved watch comes back only for its wallet, while fresh, and exactly as saved", () => {
  const now = Date.UTC(2026, 10, 10, 12, 0);
  const watch = { wallet: WALLET.toLowerCase(), startedAt: now - 60_000, baseline: { "42161:USDC": 40_000_000n, "8453:ETH": 10n ** 18n } };
  const raw = serializeExchangeWatch(watch);
  assert.deepEqual(parseExchangeWatch(raw, WALLET, now), watch, "matched case-insensitively");
  assert.equal(parseExchangeWatch(raw, "0x2222222222222222222222222222222222222222", now), null, "someone else's");
  assert.equal(parseExchangeWatch(raw, WALLET, now - 60_000 + EXCHANGE_WATCH_MS + 1), null, "too old");
  assert.equal(parseExchangeWatch(serializeExchangeWatch({ ...watch, startedAt: now + 120_000 }), WALLET, now), null, "from the future");
  for (const baseline of [{ "4663:ETH": "1" }, { "42161:USDG": "1" }, { "42161:USDC": "-1" }, { "42161:USDC": "1.5" }, { "42161:USDC": 1 }]) {
    assert.equal(parseExchangeWatch(JSON.stringify({ wallet: watch.wallet, startedAt: watch.startedAt, baseline }), WALLET, now), null, JSON.stringify(baseline));
  }
  for (const junk of [null, "", "{", "[]", "null", JSON.stringify({ wallet: watch.wallet, startedAt: "1", baseline: {} })]) assert.equal(parseExchangeWatch(junk, WALLET, now), null, String(junk));
  assert.equal(parseExchangeWatch(raw, "", now), null, "no wallet");
});

test("the guide reopens only when it was left open in this tab recently", () => {
  const now = Date.UTC(2026, 10, 10, 12, 0);
  assert.equal(exchangeGuideOpen(String(now - 5 * 60_000), now), true);
  assert.equal(exchangeGuideOpen(String(now - EXCHANGE_WATCH_MS - 1), now), false);
  assert.equal(exchangeGuideOpen(String(now + 5 * 60_000), now), false);
  for (const raw of [null, "", "soon", "NaN"]) assert.equal(exchangeGuideOpen(raw, now), false, String(raw));
});
