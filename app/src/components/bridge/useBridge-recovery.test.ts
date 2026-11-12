import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { encodeAbiParameters, encodeEventTopics, pad, type Hex } from "viem";
import * as client from "../../lib/bridge/client";
import { createBridgeTransferStore } from "../../lib/bridge/client-storage";
import { CCTP_BURN_EVENT, CCTP_FORWARD_HOOK, CCTP_TOKEN_MESSENGER, cctpBurnData } from "../../lib/bridge/cctp";
import { ARBITRUM_USDC } from "../../lib/bridge/types";

// Execute the hook's actual closures with injected browser/RPC dependencies. This keeps the
// mutation guard covered without mounting React, adding a renderer, or copying the handler.
const source = ts.createSourceFile("useBridge.ts", readFileSync(new URL("./useBridge.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function handler(name: string, bindings: Record<string, unknown>): (...args: unknown[]) => Promise<void> {
  let declaration: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === name)) declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(declaration, `controller closure ${name} exists`);
  const body = ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration, source);
  const js = ts.transpileModule(`${body}\nreturn ${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}

const address = "0x6376ca7e839f1c3dd7f23cc8a1a58329f60db125" as const;
const hash = `0x${"ab".repeat(32)}` as Hex;
const otherHash = `0x${"cd".repeat(32)}` as Hex;
const transfer: client.TrackedBridgeTransfer = {
  address, provider: "cctp", originChainId: 42161, destinationChainId: 8453, originAsset: "USDC", destinationAsset: "USDC",
  amount: "25000000", requestId: `0x${"12".repeat(32)}`, sourceBlock: "1000", status: "uncertain", destinationHashes: [], createdAt: 1_000, depositKind: "erc20",
};
transfer.depositData = cctpBurnData(transfer, 21_211n);
const burn = {
  address: CCTP_TOKEN_MESSENGER, transactionHash: hash,
  topics: encodeEventTopics({ abi: CCTP_BURN_EVENT, eventName: "DepositForBurn", args: { burnToken: ARBITRUM_USDC, depositor: address, minFinalityThreshold: 1000 } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes" }], [25_000_000n, pad(address), 6, pad(CCTP_TOKEN_MESSENGER), pad("0x00"), 21_211n, CCTP_FORWARD_HOOK]),
};
const now = transfer.createdAt + client.DISCARD_AFTER_MS + 60_000;

function harness(saved = transfer) {
  const disk = new Map<string, string>();
  const transfers = createBridgeTransferStore(() => ({
    getItem: (key) => disk.get(key) ?? null,
    setItem: (key, value) => { disk.set(key, value); },
    removeItem: (key) => { disk.delete(key); },
  }));
  transfers.save(saved);
  const state = { forgotten: false, issue: null as unknown, observation: null as unknown, invalidated: false, rpcReads: 0 };
  const pub = {
    getChainId: async () => saved.originChainId,
    getBlockNumber: async () => { state.rpcReads++; return 1_100n; },
    getLogs: async () => [burn],
    getTransaction: async () => ({ from: address, to: CCTP_TOKEN_MESSENGER, input: transfer.depositData!, value: 0n }),
  };
  const bindings = {
    ...client, actionLock: { current: false }, sending: false, discarding: false, address, tracked: saved,
    // Deliberately stale visibility: the authoritative guard must re-read the saved provider under the lock.
    canDiscard: true, navigator: { locks: { request: async (_name: string, _options: unknown, action: (lock: object) => Promise<void>) => action({}) } },
    transferLockName: () => "test-lock", setDiscarding: () => {}, transfers, config: {}, getPublicClient: () => pub,
    Date: { now: () => now }, setObservation: (value: unknown) => { state.observation = value; },
    setStatusIssue: (value: unknown) => { state.issue = value; },
    bridgeLedger: { forget: () => { state.forgotten = true; } },
    invalidateQuote: () => { state.invalidated = true; }, messageOf: client.bridgeErrorMessage,
    linkedTimeoutSignal: () => undefined,
    fetch: async () => ({ json: async () => client.CCTP_NOT_SEEN }),
    responseBody: (response: { json: () => Promise<unknown> }) => response.json(), receiptOrNull: async () => null,
    pub, trackedId: saved.requestId, stopped: false, failures: 0,
    provider: { status: "fulfilled", value: client.CCTP_NOT_SEEN }, receipt: { status: "fulfilled", value: null },
  };
  return { transfers, state, pub, bindings };
}

test("the actual discard handler keeps Circle journals despite a stale eligible UI", async (t) => {
  for (const saved of [transfer, { ...transfer, sourceBlock: undefined }, { ...transfer, sourceHash: hash }]) {
    await t.test(saved.sourceHash ? "known unmined hash" : saved.sourceBlock ? "bounded scan" : "missing source block", async () => {
      const h = harness(saved);
      const before = h.transfers.read(address);
      await handler("discard", h.bindings)();
      assert.deepEqual(h.transfers.read(address), before);
      assert.equal(h.state.forgotten, false);
      assert.equal(h.state.invalidated, false);
      assert.equal(h.state.rpcReads, 0, "Circle timeout discard is refused before any absence lookup");
    });
  }
});

test("the actual discard handler preserves the Relay waiting escape hatch and rejects fresh activity", async () => {
  const relay: client.TrackedBridgeTransfer = { address, originChainId: 8453, destinationChainId: 4663, amount: "1", requestId: transfer.requestId, sourceHash: hash, destinationHashes: [], status: "uncertain", createdAt: transfer.createdAt };
  const empty = harness(relay);
  await handler("discard", empty.bindings)();
  assert.equal(empty.transfers.read(address), null);
  assert.equal(empty.state.forgotten, true);
  for (const receipt of [{ status: "success" }, { status: "reverted" }]) {
    const active = harness(relay);
    await handler("discard", { ...active.bindings, receiptOrNull: async () => receipt })();
    assert.deepEqual(active.transfers.read(address), relay);
    assert.equal(active.state.forgotten, false);
  }
});

test("the actual poll recovers one matching Circle burn, keeps unknown burns, and preserves source reverts", async () => {
  const single = harness();
  await handler("applyStatus", single.bindings)(true);
  assert.equal(single.transfers.read(address)?.sourceHash, hash);
  assert.equal((single.state.observation as client.ProviderObservation).sourceMined, true);

  const ambiguous = harness();
  ambiguous.pub.getLogs = async () => [burn, { ...burn, transactionHash: otherHash }];
  await handler("applyStatus", ambiguous.bindings)(true);
  assert.equal(ambiguous.transfers.read(address)?.sourceHash, undefined);
  assert.equal(ambiguous.transfers.read(address)?.status, "uncertain");
  assert.equal((ambiguous.state.observation as client.ProviderObservation).sourceMined, true);

  for (const saved of [transfer, { ...transfer, sourceBlock: undefined }]) {
    const unavailable = harness(saved);
    unavailable.pub.getLogs = async () => { throw new Error("RPC log lookup unavailable"); };
    const before = unavailable.transfers.read(address);
    await handler("applyStatus", unavailable.bindings)(true);
    assert.deepEqual(unavailable.transfers.read(address), before);
    assert.equal(client.transferCanDiscard(before, unavailable.state.observation as client.ProviderObservation, now), false);
  }

  const reverted = harness({ ...transfer, sourceHash: hash });
  await handler("applyStatus", { ...reverted.bindings, receipt: { status: "fulfilled", value: { status: "reverted", transactionHash: hash } } })(true);
  const resolved = reverted.transfers.read(address)!;
  assert.equal(resolved.failureReason, "source-reverted");
  assert.equal(client.transferIsTerminal(resolved), true);
});
