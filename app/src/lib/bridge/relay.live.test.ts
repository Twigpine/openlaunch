import assert from "node:assert/strict";
import { test } from "node:test";
import { getBridgeHistory, getBridgeQuote, getBridgeStatus } from "./relay.ts";
import { relayHistoryEntry } from "./history.ts";
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

// History needs Relay's API key (GET /requests/v3). Recent requests into Robinhood Chain are read and run through the
// same parser the history board uses: the published schema must still yield rows for this bridge's routes.
test("read-only live Relay history reads /requests/v3 into board rows", { skip: process.env.RUN_BRIDGE_LIVE_TESTS !== "1" || !process.env.RELAY_API_KEY }, async (t) => {
  const response = await fetch("https://api.relay.link/requests/v3?destinationChainId=4663&limit=50&sortBy=createdAt&sortDirection=desc", { headers: { "x-api-key": process.env.RELAY_API_KEY! }, signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200);
  const body = await response.json() as { requests: { user?: string }[] };
  assert.ok(Array.isArray(body.requests) && body.requests.length > 0);
  const rows = body.requests.flatMap((request) => {
    const row = typeof request.user === "string" ? relayHistoryEntry(request, request.user) : null;
    return row ? [{ user: request.user!, row }] : [];
  });
  assert.ok(rows.length > 0, "at least one recent Robinhood transfer uses a route this bridge carries");
  t.diagnostic(JSON.stringify({ requests: body.requests.length, rows: rows.length, sample: rows[0].row }));
  // the same wallet through the server path finds that transfer
  const wallet = await getBridgeHistory(rows[0].user);
  assert.ok(wallet.relay === "on" && wallet.transfers.some((entry) => entry.requestId.toLowerCase() === rows[0].row.requestId.toLowerCase()));
});
