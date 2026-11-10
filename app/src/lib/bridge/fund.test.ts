import assert from "node:assert/strict";
import test from "node:test";
import type { Address, Hex } from "viem";
import { FUND_FOLLOW_MS, bridgeAssetForPay, followedBridge, formatFundAmount, fundStep, pickBridgeSource, readBridgeHoldings, type BridgeHolding } from "./fund.ts";
import type { BridgeHistoryEntry } from "./history.ts";
import { ARBITRUM_USDC, ARC_USDC, BASE_USDC, BRIDGE_CHAIN_IDS, BRIDGE_SEND_ASSETS, ELYSIUM_USDC, ETHEREUM_USDC, OPTIMISM_USDC, ROBINHOOD_USDG, type BridgeChainId } from "./types.ts";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const eth = (chainId: BridgeChainId, value: number): BridgeHolding => ({ chainId, asset: "ETH", amount: BigInt(Math.round(value * 1e6)) * 10n ** 12n, decimals: 18 });
const usd = (chainId: BridgeChainId, value: number, asset: "USDC" | "USDG" = "USDC"): BridgeHolding => ({ chainId, asset, amount: BigInt(Math.round(value * 1e6)), decimals: 6 });

test("a buy can be bridged for only when it pays with something the bridge delivers", () => {
  assert.equal(bridgeAssetForPay(8453, { address: NATIVE, native: true }), "ETH");
  assert.equal(bridgeAssetForPay(4663, { address: NATIVE, native: true }), "ETH");
  assert.equal(bridgeAssetForPay(5042, { address: NATIVE, native: true }), "USDC", "Arc's gas is USDC");
  assert.equal(bridgeAssetForPay(5042, { address: ARC_USDC, native: false }), "USDC", "and its ERC-20 face is the same balance");
  assert.equal(bridgeAssetForPay(8453, { address: BASE_USDC.toLowerCase() as Address, native: false }), "USDC");
  assert.equal(bridgeAssetForPay(4663, { address: ROBINHOOD_USDG, native: false }), "USDG");
  assert.equal(bridgeAssetForPay(4663, { address: BASE_USDC, native: false }), null, "Base's USDC address means nothing on Robinhood");
  assert.equal(bridgeAssetForPay(8453, { address: "0x4200000000000000000000000000000000000006", native: false }), null, "WETH is not a bridge asset");
  assert.equal(bridgeAssetForPay(8453, { address: "0x9999999999999999999999999999999999999999", native: false }), null, "a pair token or stock is not either");
  assert.equal(bridgeAssetForPay(99901, { address: NATIVE, native: true }), "HYPE", "HYPE arrives on Elysium, so a HYPE-priced buy can be funded");
  assert.equal(bridgeAssetForPay(99901, { address: ELYSIUM_USDC, native: false }), "USDC");
  assert.equal(bridgeAssetForPay(99901, { address: BASE_USDC, native: false }), null);
});

test("holdings are read on every other network, each read standing alone", async () => {
  const asked: string[] = [];
  const holdings = await readBridgeHoldings({
    native: async (chainId) => { asked.push(`${chainId}:native`); if (chainId === 10) throw new Error("rpc down"); return 7n; },
    token: async (chainId, token) => { asked.push(`${chainId}:${token}`); return chainId === 1 ? (-1n as bigint) : 5n; },
  }, WALLET, 4663);
  assert.ok(!asked.some((call) => call.startsWith("4663:")), "never the destination itself");
  // every asset the bridge can send, plus HYPE on Elysium: the gas its USDC needs to be sent, which can arrive but never leave
  const expected = BRIDGE_CHAIN_IDS.filter((id) => id !== 4663).reduce((sum, id) => sum + BRIDGE_SEND_ASSETS[id].length, 0) + 1;
  assert.equal(asked.length, expected);
  assert.ok(asked.includes("99901:native"));
  for (const token of [BASE_USDC, ARC_USDC, ELYSIUM_USDC, ETHEREUM_USDC, ARBITRUM_USDC, OPTIMISM_USDC]) assert.ok(asked.some((call) => call.endsWith(token)), token);
  assert.deepEqual(holdings.filter((h) => h.chainId === 99901), [{ chainId: 99901, asset: "USDC", amount: 5n, decimals: 6, gas: 7n }]);
  assert.ok(!holdings.some((h) => h.chainId === 10 && h.asset === "ETH"), "a network that fails is left out, not shown as empty");
  assert.ok(!holdings.some((h) => h.chainId === 1 && h.asset === "USDC"), "a nonsense answer is dropped");
  assert.deepEqual(holdings.find((h) => h.chainId === 5042), { chainId: 5042, asset: "USDC", amount: 5n, decimals: 6 });
  assert.deepEqual(holdings.find((h) => h.chainId === 42161 && h.asset === "ETH"), { chainId: 42161, asset: "ETH", amount: 7n, decimals: 18 });
});

test("Elysium's USDC counts as a source only beside some HYPE, read with it", async () => {
  const destination = { chainId: 8453, asset: "USDC" } as const;
  const elysium = (gas?: bigint): BridgeHolding => ({ ...usd(99901, 300), ...(gas === undefined ? {} : { gas }) });
  assert.deepEqual(pickBridgeSource([elysium(10n ** 15n), usd(42161, 50), eth(42161, 0.01)], destination, 3000), elysium(10n ** 15n));
  assert.deepEqual(pickBridgeSource([elysium(0n), usd(42161, 50), eth(42161, 0.01)], destination, 3000), usd(42161, 50), "no HYPE, no send");
  assert.deepEqual(pickBridgeSource([elysium(), usd(42161, 50), eth(42161, 0.01)], destination, 3000), usd(42161, 50), "an unread HYPE balance is not taken as some");
  // ETH elsewhere is not gas on Elysium
  assert.equal(pickBridgeSource([usd(99901, 300), eth(99901, 1)], destination, 3000), null);
  // a failed HYPE read leaves the USDC holding in place, without gas
  const holdings = await readBridgeHoldings({
    native: async (chainId) => { if (chainId === 99901) throw new Error("rpc down"); return 1n; },
    token: async () => 9n,
  }, WALLET, 8453);
  assert.deepEqual(holdings.filter((h) => h.chainId === 99901), [{ chainId: 99901, asset: "USDC", amount: 9n, decimals: 6 }]);
});

test("the suggested source is the largest one worth moving that can actually be sent", () => {
  const destination = { chainId: 4663, asset: "ETH" } as const;
  // with a price: dollars and ETH compare by value
  assert.deepEqual(pickBridgeSource([eth(42161, 0.02), usd(8453, 120), eth(8453, 0.001)], destination, 3000), usd(8453, 120));
  assert.deepEqual(pickBridgeSource([eth(42161, 0.05), usd(8453, 120), eth(8453, 0.001)], destination, 3000), eth(42161, 0.05));
  // a token needs gas beside it; Arc's USDC is its own gas
  assert.deepEqual(pickBridgeSource([usd(10, 500), eth(10, 0), eth(1, 0.01)], destination, 3000), eth(1, 0.01), "USDC on Optimism with no ETH there cannot be sent");
  assert.deepEqual(pickBridgeSource([usd(5042, 40), eth(1, 0.001)], destination, 3000), usd(5042, 40));
  // dust and the destination itself never count
  assert.equal(pickBridgeSource([eth(42161, 0.0002), usd(5042, 0.5)], destination, 3000), null);
  assert.equal(pickBridgeSource([eth(4663, 3)], destination, 3000), null);
  assert.equal(pickBridgeSource([], destination, 3000), null);
  // no price: like with like, the buy's own kind first
  assert.deepEqual(pickBridgeSource([usd(8453, 900), eth(42161, 0.01), eth(1, 0.2)], destination, null), eth(1, 0.2));
  assert.deepEqual(pickBridgeSource([usd(8453, 900), eth(8453, 0.0001), eth(42161, 0.0001)], destination, null), usd(8453, 900), "with no ETH worth moving, dollars are still a route");
  assert.deepEqual(pickBridgeSource([usd(8453, 30), usd(5042, 80), eth(8453, 1)], { chainId: 4663, asset: "USDG" }, Number.NaN), usd(5042, 80), "a broken price is no price");
  // equal values: the lower chain id, so the answer never flips between renders
  assert.equal(pickBridgeSource([usd(42161, 50), usd(8453, 50), eth(42161, 1), eth(8453, 1)], { chainId: 5042, asset: "USDC" }, null)!.chainId, 8453);
});

test("hint amounts keep four decimals at most and never show dust as zero", () => {
  assert.equal(formatFundAmount(123456789n, 6), "123.4567");
  assert.equal(formatFundAmount(1_234_000_000n, 6), "1,234");
  assert.equal(formatFundAmount(10n ** 13n, 18), "<0.0001");
  assert.equal(formatFundAmount(0n, 18), "0");
  assert.equal(formatFundAmount(5n * 10n ** 16n, 18), "0.05");
});

function row(overrides: Partial<BridgeHistoryEntry> = {}): BridgeHistoryEntry {
  return { requestId: hash(1), originChainId: 42161, destinationChainId: 4663, originAsset: "ETH", destinationAsset: "ETH", amountIn: "50000000000000000", inDecimals: 18, amountOut: "49800000000000000", outDecimals: 18, outKind: "quoted", status: "pending", reverted: false, createdAt: 1_000_000, sourceHash: hash(2), destinationHashes: [], recipient: null, ...overrides };
}

test("the trade panel follows the newest recent transfer into its network, until dismissed", () => {
  const now = 1_000_000 + 60_000;
  const rows = [row(), row({ requestId: hash(3), createdAt: 900_000 }), row({ requestId: hash(4), destinationChainId: 8453, createdAt: 1_050_000 })];
  assert.equal(followedBridge(rows, 4663, now, [])!.requestId, hash(1));
  assert.equal(followedBridge(rows, 4663, now, [hash(1).toUpperCase().replace("0X", "0x")])!.requestId, hash(3), "a dismissed one gives way to the next");
  assert.equal(followedBridge(rows, 5042, now, []), null);
  assert.equal(followedBridge([row({ createdAt: now - FUND_FOLLOW_MS - 1 })], 4663, now, []), null, "an old transfer is history, not a step");
  assert.equal(followedBridge([row({ createdAt: now + 120_000 })], 4663, now, []), null, "a clock far ahead is not trusted");
  assert.equal(followedBridge([row({ recipient: "0x2222222222222222222222222222222222222222" })], 4663, now, []), null, "funds sent elsewhere are no help to this wallet's buy");

  assert.equal(fundStep(null), "short");
  for (const status of ["waiting", "depositing", "pending", "submitted", "delayed"] as const) assert.equal(fundStep({ status }), "moving", status);
  assert.equal(fundStep({ status: "success" }), "arrived");
  for (const status of ["refund", "failure", "uncertain"] as const) assert.equal(fundStep({ status }), "attention", status);
});
