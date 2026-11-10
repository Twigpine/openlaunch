import assert from "node:assert/strict";
import test from "node:test";
import { formatUnits, zeroAddress } from "viem";
import { ARC_USDC, BASE_USDC, BRIDGE_ASSET_NAMES, BRIDGE_CHAIN_IDS, BRIDGE_CHAINS, BRIDGE_DESTINATION_IDS, BRIDGE_RECEIVE_ASSETS, BRIDGE_SEND_ASSETS, ELYSIUM_USDC, ROBINHOOD_USDG, bridgeAssets, bridgeCurrency, bridgeCurrencyAsset, bridgeDestinationRefund, bridgeFeePercent, bridgeTokenAsset, bridgeTokens, bridgeTransferInputCurrency, bridgesNativeCurrency, defaultBridgeAsset, isBridgeAssetSupported, isBridgeDestination, isDollarAsset } from "./types";
import { launchpad } from "../launchpad/config";

test("bridge assets are chain-scoped and never inferred from a symbol alone", () => {
  // Base, Robinhood Chain and Arc send exactly what they receive
  for (const side of ["input", "output"] as const) {
    assert.deepEqual(bridgeAssets(8453, side), ["ETH", "USDC"]);
    assert.deepEqual(bridgeAssets(4663, side), ["ETH", "USDG"]);
    assert.deepEqual(bridgeAssets(5042, side), ["USDC"]);
    assert.equal(isBridgeAssetSupported(4663, "USDC", side), false);
    assert.equal(isBridgeAssetSupported(8453, BASE_USDC, side), false);
    assert.equal(isBridgeAssetSupported(8453, "usdc", side), false);
    assert.equal(isBridgeAssetSupported(4663, "usdg", side), false);
    assert.equal(isBridgeAssetSupported(4663, ROBINHOOD_USDG, side), false);
  }
  assert.equal(bridgeAssets(8453, "input"), BRIDGE_SEND_ASSETS[8453]);
  assert.equal(bridgeAssets(8453, "output"), BRIDGE_RECEIVE_ASSETS[8453]);
  assert.throws(() => bridgeCurrency(4663, "USDC", "input"));
  assert.throws(() => bridgeCurrency(4663, "USDC", "output"));
  assert.throws(() => bridgeCurrency(5042, "ETH", "input"));
  // USDG is Robinhood Chain's alone, and USDC is still not offered there
  for (const chain of [8453, 5042] as const) {
    assert.equal(isBridgeAssetSupported(chain, "USDG", "output"), false);
    assert.throws(() => bridgeCurrency(chain, "USDG", "output"));
  }
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

test("every chain keeps its gas token as the default where the bridge carries it, and has at most one ERC-20", () => {
  assert.deepEqual(BRIDGE_CHAIN_IDS.map(bridgeTokenAsset), ["USDC", "USDG", "USDC", "USDC", "USDC", "USDC", "USDC"]);
  // Elysium alone has a gas token the bridge cannot send: HYPE only arrives there, swapped from its USDC
  assert.deepEqual(BRIDGE_CHAIN_IDS.filter((chain) => !bridgesNativeCurrency(chain)), [99901]);
  for (const chain of BRIDGE_CHAIN_IDS) {
    assert.equal(defaultBridgeAsset(chain), bridgesNativeCurrency(chain) ? BRIDGE_CHAINS[chain].symbol : bridgeTokenAsset(chain));
    assert.ok(isBridgeAssetSupported(chain, defaultBridgeAsset(chain), "input"), String(chain));
    if (isBridgeDestination(chain)) assert.ok(isBridgeAssetSupported(chain, defaultBridgeAsset(chain), "output"), String(chain));
    // approvals are journaled per chain (approval.ts), so a second ERC-20 on one chain would be ambiguous there
    const tokens = BRIDGE_SEND_ASSETS[chain].filter((asset) => bridgeCurrency(chain, asset, "input").address !== zeroAddress);
    assert.ok(tokens.length <= 1, `${chain}: ${tokens.join(", ")}`);
    for (const asset of [...BRIDGE_SEND_ASSETS[chain], ...BRIDGE_RECEIVE_ASSETS[chain]]) assert.ok(BRIDGE_ASSET_NAMES[asset].length > 0, asset);
  }
  assert.deepEqual(["ETH", "USDC", "USDG", "HYPE"].map((asset) => isDollarAsset(asset as "ETH")), [false, true, true, false]);
  assert.equal(BRIDGE_ASSET_NAMES.HYPE, "Hyperliquid");
  assert.equal(BRIDGE_ASSET_NAMES.USDG, "Global Dollar");
});

test("Elysium sends its USDC and receives USDC or HYPE, never sending HYPE", () => {
  assert.ok(isBridgeDestination(99901) && (BRIDGE_DESTINATION_IDS as readonly number[]).includes(99901));
  assert.deepEqual(BRIDGE_SEND_ASSETS[99901], ["USDC"]);
  assert.deepEqual(BRIDGE_RECEIVE_ASSETS[99901], ["USDC", "HYPE"]);
  assert.equal(defaultBridgeAsset(99901), "USDC");
  for (const side of ["input", "output"] as const) {
    assert.deepEqual(bridgeCurrency(99901, "USDC", side), { address: ELYSIUM_USDC, symbol: "USDC", decimals: 6 });
    assert.deepEqual(bridgeCurrency(99901, undefined, side), { address: ELYSIUM_USDC, symbol: "USDC", decimals: 6 });
  }
  // HYPE arrives as Elysium's native balance, and is never sent from it
  assert.deepEqual(bridgeCurrency(99901, "HYPE", "output"), { address: zeroAddress, symbol: "HYPE", decimals: 18 });
  assert.equal(isBridgeAssetSupported(99901, "HYPE", "output"), true);
  assert.equal(isBridgeAssetSupported(99901, "HYPE", "input"), false);
  assert.throws(() => bridgeCurrency(99901, "HYPE", "input"), /not supported/);
  for (const side of ["input", "output"] as const) {
    for (const asset of ["ETH", "USDG", "hype"]) assert.equal(isBridgeAssetSupported(99901, asset, side), false, asset);
    // HYPE is Elysium's alone
    for (const chain of BRIDGE_CHAIN_IDS.filter((id) => id !== 99901)) assert.equal(isBridgeAssetSupported(chain, "HYPE", side), false, String(chain));
  }
  assert.throws(() => bridgeCurrency(99901, "ETH", "output"), /not supported/);
  assert.deepEqual(bridgeCurrencyAsset(99901, zeroAddress), { asset: "HYPE", decimals: 18 }, "Relay's records name delivered HYPE by the native address");
  assert.deepEqual(bridgeCurrencyAsset(99901, ELYSIUM_USDC.toLowerCase()), { asset: "USDC", decimals: 6 });
  assert.equal(bridgeCurrencyAsset(8453, ELYSIUM_USDC), null);
  assert.deepEqual(bridgeTokens(99901), [{ address: ELYSIUM_USDC, symbol: "USDC", decimals: 6 }], "HYPE's refund is that same USDC");
  assert.deepEqual(bridgeTokens(5042), [{ address: ARC_USDC, symbol: "USDC", decimals: 6 }], "Arc's native USDC output is not a token");
  assert.equal(BRIDGE_CHAINS[99901].symbol, "HYPE");
});

test("a failed fill refunds in its own output on the destination, except HYPE, which refunds in Elysium USDC", () => {
  for (const chain of BRIDGE_DESTINATION_IDS) for (const asset of BRIDGE_RECEIVE_ASSETS[chain]) {
    const expected = chain === 99901 && asset === "HYPE" ? { address: ELYSIUM_USDC, symbol: "USDC", decimals: 6 } : bridgeCurrency(chain, asset, "output");
    assert.deepEqual(bridgeDestinationRefund(chain, asset), expected, `${chain}:${asset}`);
  }
  // Arc still refunds its native USDC, and an omitted asset is the chain's default
  assert.deepEqual(bridgeDestinationRefund(5042, "USDC"), { address: zeroAddress, symbol: "USDC", decimals: 18 });
  assert.deepEqual(bridgeDestinationRefund(99901, undefined), { address: ELYSIUM_USDC, symbol: "USDC", decimals: 6 });
  assert.throws(() => bridgeDestinationRefund(8453, "HYPE"), /not supported/);
  // a copy, like every currency the table hands out
  const copy = bridgeDestinationRefund(99901, "HYPE");
  copy.decimals = 18;
  assert.equal(bridgeDestinationRefund(99901, "HYPE").decimals, 6);
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
