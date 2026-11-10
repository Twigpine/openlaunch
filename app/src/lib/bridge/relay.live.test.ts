import assert from "node:assert/strict";
import { test } from "node:test";
import { getBridgeQuote, getBridgeStatus } from "./relay.ts";
import { formatUnits } from "viem";
import { BRIDGE_ASSETS, BRIDGE_CHAINS, BRIDGE_CHAIN_IDS, BRIDGE_DESTINATION_IDS, bridgeCurrency } from "./types.ts";

// Explicit opt-in. This only requests quotes/status using a public dummy address;
// it never connects a wallet, signs, or submits a transaction.
// Every source (the launch chains and the funding networks) into every launch chain: forty-six routes.
for (const originChainId of BRIDGE_CHAIN_IDS) for (const destinationChainId of BRIDGE_DESTINATION_IDS) {
  if (originChainId === destinationChainId) continue;
  for (const originAsset of BRIDGE_ASSETS[originChainId]) for (const destinationAsset of BRIDGE_ASSETS[destinationChainId]) {
  test(`read-only live Relay ${originChainId}:${originAsset}→${destinationChainId}:${destinationAsset}`, { skip: process.env.RUN_BRIDGE_LIVE_TESTS !== "1" }, async (t) => {
    // 25 units of a six-decimal token (USDC, USDG), or 0.01 ETH
    const amount = bridgeCurrency(originChainId, originAsset, "input").decimals === 6 ? "25000000" : "10000000000000000";
    const quote = await getBridgeQuote({ address: "0x1111111111111111111111111111111111111111", originChainId, destinationChainId, originAsset, destinationAsset, amount });
    assert.ok(BigInt(quote.amountOut) > 0n);
    assert.equal(quote.transaction.chainId, originChainId);
    assert.ok(quote.expiresAt > Date.now());
    const status = await getBridgeStatus(quote.requestId);
    assert.equal(status.status, "waiting");
    t.diagnostic(JSON.stringify({ route: `${BRIDGE_CHAINS[originChainId].name}:${originAsset}→${BRIDGE_CHAINS[destinationChainId].name}:${destinationAsset}`, input: formatUnits(BigInt(amount), bridgeCurrency(originChainId, originAsset, "input").decimals), output: formatUnits(BigInt(quote.amountOut), bridgeCurrency(destinationChainId, destinationAsset, "output").decimals), minimumOutput: formatUnits(BigInt(quote.minimumAmountOut), bridgeCurrency(destinationChainId, destinationAsset, "output").decimals), sourceInputRelayFee: quote.relayFee, sourceNativeGas: quote.sourceGas, totalImpactPercent: quote.totalImpactPercent, approval: quote.approval ?? null, status: status.status }));
  });
  }
}
