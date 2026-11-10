import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicClient, http } from "viem";
import { CCTP_DESTINATIONS, CCTP_DOMAINS, CCTP_TOKEN_MESSENGER, cctpBurnData, cctpRoute, isCctpBurnLog } from "./cctp.ts";
import { getCctpQuote, getCctpStatus } from "./cctp-server.ts";
import { validateBridgeQuote, type TrackedBridgeTransfer } from "./client.ts";
import { BRIDGE_CHAINS, type BridgeChainId } from "./types.ts";

// Explicit opt-in, read-only: Circle's public fee and message endpoints and public RPC nodes. No wallet, no signing.
const live = { skip: process.env.RUN_BRIDGE_LIVE_TESTS !== "1" };
const DUMMY = "0x1111111111111111111111111111111111111111" as const;

for (const originChainId of Object.keys(CCTP_DOMAINS).map(Number) as BridgeChainId[]) for (const destinationChainId of CCTP_DESTINATIONS) {
  if (originChainId === destinationChainId) continue;
  test(`read-only live Circle quote ${BRIDGE_CHAINS[originChainId].name} USDC to ${BRIDGE_CHAINS[destinationChainId].name} USDC`, live, async (t) => {
    const request = { address: DUMMY, originChainId, destinationChainId, originAsset: "USDC" as const, destinationAsset: "USDC" as const, amount: "25000000" };
    assert.ok(cctpRoute(request));
    const quote = await getCctpQuote(request, fetch);
    assert.ok(quote, "Circle offered no quote");
    assert.deepEqual(validateBridgeQuote(quote, request, Date.now()), quote);
    t.diagnostic(`fee ${quote.relayFee} USDC, receives ${quote.amountOut}, about ${quote.timeEstimate}s`);
  });
}

// A real forwarded burn, Ethereum USDC to Arc: the calldata this bridge builds must produce exactly its event, and
// Circle's record of it must read as delivered with the mint transaction it reported on 2026-11-10.
test("read-only live Circle burn matches this bridge's own encoding and reads as delivered", live, async () => {
  const hash = "0x009551050ec596b833a8957d635c759dbd22b63d45977c9d4cde5dcc79bece01" as const;
  const transfer: TrackedBridgeTransfer = {
    provider: "cctp", address: "0x6376ca7e839f1c3dd7f23cc8a1a58329f60db125", originChainId: 1, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC",
    amount: "2343317655", requestId: `0x${"1".repeat(64)}`, destinationHashes: [], status: "pending", createdAt: 1, depositKind: "erc20",
    depositData: cctpBurnData({ address: "0x6376ca7e839f1c3dd7f23cc8a1a58329f60db125", originChainId: 1, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC", amount: "2343317655" }, 89_262n),
  };
  const client = createPublicClient({ transport: http("https://ethereum-rpc.publicnode.com", { timeout: 30_000 }) });
  const receipt = await client.getTransactionReceipt({ hash });
  const burns = receipt.logs.filter((log) => log.address.toLowerCase() === CCTP_TOKEN_MESSENGER.toLowerCase());
  assert.equal(burns.length, 1);
  assert.equal(isCctpBurnLog(burns[0], transfer), true);
  const status = await getCctpStatus({ originChainId: 1, destinationChainId: 5042, hash, address: transfer.address, amount: transfer.amount }, fetch);
  assert.deepEqual(status, { status: "success", inTxHashes: [hash], txHashes: ["0xec343f34384181675084e7bb39863235c060fa075521984a2a22eedd05029531"] });
});
