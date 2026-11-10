import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { submitExactApproval, type ApprovalDependencies, type ApprovalRequest } from "./approval";
import { ERC20_DEPOSIT_ABI, NATIVE_DEPOSIT_ABI, RELAY_DEPOSITORY, submitBridgeDeposit, type DepositDependencies } from "./client";
import { assertBridgeWalletQueueClear } from "./transaction-preflight";
import { BRIDGE_ASSETS, BRIDGE_CHAINS, BRIDGE_CHAIN_IDS, BRIDGE_DESTINATION_IDS, bridgeCurrency, type BridgeAsset, type BridgeChainId, type BridgeQuote } from "./types";

const ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const HASH = `0x${"a".repeat(64)}` as Hex;
const ORDER = `0x${"b".repeat(64)}` as Hex;
const NOW = 1_800_000_000_000;
const GAS = { gas: 100_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };

function clientFor(pending: number, latest: number, events: string[] = []) {
  return {
    async getTransactionCount(request: { address: Address; blockTag: "latest" | "pending" }) {
      assert.equal(request.address, ADDRESS);
      events.push(request.blockTag);
      return request.blockTag === "pending" ? pending : latest;
    },
  };
}

test("a clear source-wallet queue accepts zero and nonzero confirmed nonces on every bridge network", async () => {
  for (const { name } of Object.values(BRIDGE_CHAINS)) {
    for (const count of [0, 17, Number.MAX_SAFE_INTEGER]) {
      const events: string[] = [];
      await assertBridgeWalletQueueClear(clientFor(count, count, events), ADDRESS, name);
      assert.deepEqual(events, ["pending", "latest"]);
    }
  }
});

test("a visible pending queue blocks with source-network and earliest-transaction guidance", async () => {
  for (const { name } of Object.values(BRIDGE_CHAINS)) {
    await assert.rejects(assertBridgeWalletQueueClear(clientFor(3, 0), ADDRESS, name), (error: Error) => {
      assert.match(error.message, new RegExp(`pending transaction on ${name}`));
      assert.match(error.message, /Open your wallet and resolve the earliest pending transaction before approving or bridging/);
      return true;
    });
  }
});

test("latest is not requested until the pending observation completes", async () => {
  const events: string[] = [];
  let resolvePending!: (value: number) => void;
  const pending = new Promise<number>((resolve) => { resolvePending = resolve; });
  const checking = assertBridgeWalletQueueClear({
    getTransactionCount: async ({ blockTag }) => {
      events.push(blockTag);
      return blockTag === "pending" ? pending : 7;
    },
  }, ADDRESS, "Arc");
  assert.deepEqual(events, ["pending"]);
  resolvePending(7);
  await checking;
  assert.deepEqual(events, ["pending", "latest"]);
});

test("a newer confirmed nonce fails closed without claiming a pending wallet transaction", async () => {
  await assert.rejects(assertBridgeWalletQueueClear(clientFor(2, 3), ADDRESS, "Arc"), (error: Error) => {
    assert.match(error.message, /consistent transaction count on Arc/);
    assert.match(error.message, /Wait a moment and try again/);
    assert.doesNotMatch(error.message, /wallet has a pending|resolve the earliest/);
    return true;
  });
});

test("malformed or unsafe transaction counts cannot allow approval or deposit", async () => {
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0", null, undefined]) {
    for (const [pending, latest] of [[invalid, 0], [0, invalid]]) {
      await assert.rejects(assertBridgeWalletQueueClear(clientFor(pending as number, latest as number), ADDRESS, "Base"), /consistent transaction count on Base/);
    }
  }
});

test("RPC failures remain the original error and never become a claim about the wallet queue", async () => {
  for (const failedRead of ["pending", "latest"] as const) {
    const error = new Error(`RPC ${failedRead} unavailable`);
    const events: string[] = [];
    await assert.rejects(assertBridgeWalletQueueClear({
      getTransactionCount: async ({ blockTag }) => {
        events.push(blockTag);
        if (blockTag === failedRead) throw error;
        return 0;
      },
    }, ADDRESS, "Arc"), (received) => received === error);
    assert.deepEqual(events, failedRead === "pending" ? ["pending"] : ["pending", "latest"]);
  }
});

function approvalScenario(chainId: 8453 | 5042, pending: number, latest: number) {
  const events: string[] = [];
  const request: ApprovalRequest = { address: ADDRESS, chainId, amount: "500000" };
  const deps: ApprovalDependencies = {
    now: () => NOW,
    currentRequest: () => request,
    readWallet: async () => ({ address: ADDRESS, chainId }),
    switchChain: async () => assert.fail("already on source network"),
    prepare: async () => {
      await assertBridgeWalletQueueClear(clientFor(pending, latest, events), ADDRESS, BRIDGE_CHAINS[chainId].name);
      return GAS;
    },
    readApproval: () => null,
    saveApproval: (approval) => { events.push(`save:${approval.status}`); },
    removeApproval: () => { events.push("remove"); },
    send: async () => { events.push("send"); return HASH; },
    phase: (phase) => { events.push(`phase:${phase}`); },
  };
  return { request, deps, events };
}

test("USDC approval preflight blocks both source networks before journaling or opening the wallet", async () => {
  for (const chainId of [8453, 5042] as const) {
    for (const [pending, latest] of [[3, 0], [0, 1], [-1, 0]]) {
      const scenario = approvalScenario(chainId, pending, latest);
      await assert.rejects(submitExactApproval(scenario.request, scenario.deps), /pending transaction|consistent transaction count/);
      assert.deepEqual(scenario.events, ["pending", "latest"]);
    }
  }
});

function quote(originChainId: BridgeChainId, destinationChainId: BridgeChainId, originAsset: BridgeAsset, destinationAsset: BridgeAsset): BridgeQuote {
  const currency = bridgeCurrency(originChainId, originAsset, "input");
  const amount = (10n ** BigInt(currency.decimals)).toString();
  const erc20 = !/^0x0{40}$/.test(currency.address);
  return {
    address: ADDRESS, originChainId, destinationChainId, originAsset, destinationAsset, amount,
    requestId: HASH, amountOut: "990000", minimumAmountOut: "980000",
    relayFee: "0.001", sourceGas: "0.00001", totalImpactPercent: "-1", timeEstimate: 15, expiresAt: NOW + 45_000, ttlMs: 45_000,
    ...(erc20 ? { approval: { token: currency.address, spender: RELAY_DEPOSITORY, amount } } : {}),
    transaction: {
      to: RELAY_DEPOSITORY, chainId: originChainId, value: erc20 ? "0" : amount,
      data: erc20
        ? encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [ADDRESS, currency.address, BigInt(amount), ORDER] })
        : encodeFunctionData({ abi: NATIVE_DEPOSIT_ABI, functionName: "depositNative", args: [ADDRESS, ORDER] }),
    },
  };
}

function depositScenario(q: BridgeQuote, pending: number, latest: number) {
  const events: string[] = [];
  const deps: DepositDependencies = {
    now: () => NOW,
    currentRequest: () => q,
    readWallet: async () => ({ address: ADDRESS, chainId: q.originChainId }),
    switchChain: async () => assert.fail("already on source network"),
    prepare: async () => {
      await assertBridgeWalletQueueClear(clientFor(pending, latest, events), ADDRESS, BRIDGE_CHAINS[q.originChainId].name);
      return GAS;
    },
    readTransfer: () => null,
    saveTransfer: (transfer) => { events.push(`save:${transfer.status}`); },
    removeTransfer: () => { events.push("remove"); },
    send: async () => { events.push("send"); return HASH; },
    phase: (phase) => { events.push(`phase:${phase}`); },
  };
  return { deps, events };
}

test("all forty-six supported deposit routes block queued nonces before journaling or sending", async () => {
  let routes = 0;
  // sixteen between the launch chains, thirty from the funding networks (two assets each to five launch-chain assets)
  for (const origin of BRIDGE_CHAIN_IDS) for (const destination of BRIDGE_DESTINATION_IDS) {
    if (origin === destination) continue;
    for (const originAsset of BRIDGE_ASSETS[origin]) for (const destinationAsset of BRIDGE_ASSETS[destination]) {
      const q = quote(origin, destination, originAsset, destinationAsset);
      const scenario = depositScenario(q, 3, 0);
      await assert.rejects(submitBridgeDeposit(q, scenario.deps), /pending transaction/);
      assert.deepEqual(scenario.events, ["pending", "latest"]);
      routes++;
    }
  }
  assert.equal(routes, 46);
});

test("clear queues preserve explicit approval and deposit submission order", async () => {
  const approval = approvalScenario(5042, 4, 4);
  assert.equal((await submitExactApproval(approval.request, approval.deps)).kind, "sent");
  const q = quote(5042, 8453, "USDC", "USDC");
  const deposit = depositScenario(q, 5, 5);
  assert.equal((await submitBridgeDeposit(q, deposit.deps)).kind, "sent");
  for (const events of [approval.events, deposit.events]) {
    assert.deepEqual(events, ["pending", "latest", "save:uncertain", "phase:confirming", "send", "save:pending"]);
  }
});
