import assert from "node:assert/strict";
import test from "node:test";
import { formatUnits, zeroAddress } from "viem";
import { ARC_USDC, BASE_USDC, BRIDGE_ASSETS, BRIDGE_ASSET_NAMES, BRIDGE_CHAIN_IDS, BRIDGE_CHAINS, ROBINHOOD_USDG, bridgeCurrency, bridgeFeePercent, bridgeTokenAsset, bridgeTransferInputCurrency, defaultBridgeAsset, isBridgeAssetSupported, isDollarAsset } from "./types";
import { launchpad } from "../launchpad/config";

test("bridge assets are chain-scoped and never inferred from a symbol alone", () => {
  assert.deepEqual(BRIDGE_ASSETS[8453], ["ETH", "USDC"]);
  assert.deepEqual(BRIDGE_ASSETS[4663], ["ETH", "USDG"]);
  assert.deepEqual(BRIDGE_ASSETS[5042], ["USDC"]);
  assert.equal(isBridgeAssetSupported(4663, "USDC"), false);
  assert.equal(isBridgeAssetSupported(8453, BASE_USDC), false);
  assert.equal(isBridgeAssetSupported(8453, "usdc"), false);
  assert.throws(() => bridgeCurrency(4663, "USDC", "input"));
  assert.throws(() => bridgeCurrency(4663, "USDC", "output"));
  assert.throws(() => bridgeCurrency(5042, "ETH", "input"));
  // USDG is Robinhood Chain's alone, and USDC is still not offered there
  for (const chain of [8453, 5042] as const) {
    assert.equal(isBridgeAssetSupported(chain, "USDG"), false);
    assert.throws(() => bridgeCurrency(chain, "USDG", "output"));
  }
  assert.equal(isBridgeAssetSupported(4663, "usdg"), false);
  assert.equal(isBridgeAssetSupported(4663, ROBINHOOD_USDG), false);
});

test("Robinhood USDG is the launch form's own six-decimal contract in both directions", () => {
  for (const side of ["input", "output"] as const) {
    assert.deepEqual(bridgeCurrency(4663, "USDG", side), { address: ROBINHOOD_USDG, symbol: "USDG", decimals: 6 });
  }
  assert.equal(ROBINHOOD_USDG, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  // one contract, named once more in the launch config: the bridge must deliver the token the form prices in
  const usdg = launchpad("robinhood").quotes.find((quote) => quote.key === "usdg");
  assert.equal(usdg?.address.toLowerCase(), ROBINHOOD_USDG.toLowerCase());
  assert.equal(usdg?.decimals, 6);
  // a returned currency is a copy: nothing a caller does to it changes the table
  const copy = bridgeCurrency(4663, "USDG", "input");
  copy.decimals = 18;
  assert.equal(bridgeCurrency(4663, "USDG", "input").decimals, 6);
});

test("every chain keeps its gas token as the default and has at most one ERC-20", () => {
  assert.deepEqual(BRIDGE_CHAIN_IDS.map(bridgeTokenAsset), ["USDC", "USDG", "USDC", "USDC", "USDC", "USDC"]);
  for (const chain of BRIDGE_CHAIN_IDS) {
    assert.equal(defaultBridgeAsset(chain), BRIDGE_CHAINS[chain].symbol);
    assert.ok(isBridgeAssetSupported(chain, defaultBridgeAsset(chain)), String(chain));
    // approvals are journaled per chain (approval.ts), so a second ERC-20 on one chain would be ambiguous there
    const tokens = BRIDGE_ASSETS[chain].filter((asset) => bridgeCurrency(chain, asset, "input").address !== zeroAddress);
    assert.ok(tokens.length <= 1, `${chain}: ${tokens.join(", ")}`);
    for (const asset of BRIDGE_ASSETS[chain]) assert.ok(BRIDGE_ASSET_NAMES[asset].length > 0, asset);
  }
  assert.deepEqual(["ETH", "USDC", "USDG"].map((asset) => isDollarAsset(asset as "ETH")), [false, true, true]);
  assert.equal(BRIDGE_ASSET_NAMES.USDG, "Global Dollar");
});

test("Base USDC uses the same six-decimal contract in both directions", () => {
  for (const side of ["input", "output"] as const) {
    assert.deepEqual(bridgeCurrency(8453, "USDC", side), { address: BASE_USDC, symbol: "USDC", decimals: 6 });
  }
});

test("Arc keeps distinct ERC20 input and native output representations", () => {
  assert.deepEqual(bridgeCurrency(5042, "USDC", "input"), { address: ARC_USDC, symbol: "USDC", decimals: 6 });
  assert.deepEqual(bridgeCurrency(5042, "USDC", "output"), { address: zeroAddress, symbol: "USDC", decimals: 18 });
});

test("omitted asset fields preserve legacy route semantics", () => {
  for (const chain of [8453, 4663] as const) {
    for (const side of ["input", "output"] as const) assert.deepEqual(bridgeCurrency(chain, undefined, side), { address: zeroAddress, symbol: "ETH", decimals: 18 });
  }
  assert.equal(bridgeCurrency(5042, undefined, "input").address, ARC_USDC);
  assert.equal(bridgeCurrency(5042, undefined, "output").address, zeroAddress);
});

test("recovered Arc native and ERC20 journals both display the original USDC amount", () => {
  const native = bridgeTransferInputCurrency({ originChainId: 5042 });
  assert.equal(native.address, zeroAddress);
  assert.equal(formatUnits(25n * 10n ** 18n, native.decimals), "25");
  const erc20 = bridgeTransferInputCurrency({ originChainId: 5042, depositKind: "erc20" });
  assert.equal(erc20.address, ARC_USDC);
  assert.equal(formatUnits(25_000_000n, erc20.decimals), "25");
  const modern = bridgeTransferInputCurrency({ originChainId: 5042, originAsset: "USDC", depositKind: "erc20" });
  assert.deepEqual(modern, erc20);
  assert.equal(bridgeTransferInputCurrency({ originChainId: 8453 }).decimals, 18);
  assert.equal(bridgeTransferInputCurrency({ originChainId: 8453, originAsset: "USDC", depositKind: "erc20" }).decimals, 6);
});

test("relay fee percentages preserve exact boundaries and round upward without floats", () => {
  assert.equal(bridgeFeePercent(50_000n, 1_000_000n), "5");
  assert.equal(bridgeFeePercent(50_001n, 1_000_000n), "5.0001");
  assert.equal(bridgeFeePercent(500_000_000_000_001n, 10_000_000_000_000_000n), "5.000001");
  assert.equal(bridgeFeePercent(1n, 3n), "33.333334");
  assert.equal(bridgeFeePercent(0n, 1n), "0");
  assert.throws(() => bridgeFeePercent(-1n, 1n));
  assert.throws(() => bridgeFeePercent(1n, 0n));
});
