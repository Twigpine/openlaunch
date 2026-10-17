import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, HttpRequestError, InsufficientFundsError, RpcRequestError, SwitchChainError, UnknownRpcError, UserRejectedRequestError, type Address, type Hex } from "viem";
import { activityAfterWalletChange, anchorQuoteExpiry, bridgeErrorMessage, DISCARD_AFTER_MS, linkedTimeoutSignal, replacementSourceHash, transferCanDiscard, bridgeGasBudget, bridgeRequest, bridgeRequestKey, changeBridgeRoute, ERC20_DEPOSIT_ABI, ERC20_DEPOSIT_EVENT, hasMatchingDepositEvent, isMatchingSourceDeposit, isWalletRejection, mergeBridgeStatus, nativeSourceAmount, NATIVE_DEPOSIT_ABI, NATIVE_DEPOSIT_EVENT, parseBridgeAmount, parseStoredTransfer, RELAY_DEPOSITORY, serializeTransfer, submitBridgeDeposit, transferIsTerminal, validateBridgeQuote, validateBridgeStatus, type DepositDependencies, type TrackedBridgeTransfer } from "./client";
import { bridgeStorageKey, createBridgeTransferStore } from "./client-storage";
import { parseBridgeQuoteRejection } from "./client";
import { ARC_USDC, BASE_USDC, BRIDGE_CHAIN_IDS, type BridgeQuote, type BridgeQuoteRejection, type BridgeQuoteRequest } from "./types";

const ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const REQUEST = `0x${"a".repeat(64)}` as Hex;
const ORDER = `0x${"b".repeat(64)}` as Hex;
const HASH = `0x${"c".repeat(64)}` as Hex;
const DEST_HASH = `0x${"d".repeat(64)}` as Hex;
const NOW = 1_800_000_000_000;
const amount = "10000000000000000";

function quote(): BridgeQuote {
  return {
    address: ADDRESS, originChainId: 8453, destinationChainId: 4663, amount,
    requestId: REQUEST, amountOut: "9800000000000000", minimumAmountOut: "9700000000000000",
    relayFee: "0.0002", sourceGas: "0.00001", totalImpactPercent: "-2", timeEstimate: 15, expiresAt: NOW + 45_000, ttlMs: 45_000,
    transaction: { to: RELAY_DEPOSITORY, data: encodeFunctionData({ abi: NATIVE_DEPOSIT_ABI, functionName: "depositNative", args: [ADDRESS, ORDER] }), value: amount, chainId: 8453 },
  };
}

function tracked(): TrackedBridgeTransfer {
  return { address: ADDRESS, originChainId: 8453, destinationChainId: 4663, amount, requestId: REQUEST, destinationHashes: [], status: "uncertain", createdAt: NOW, depositData: quote().transaction.data };
}

function arcQuote(destinationChainId: 8453 | 4663 = 8453): BridgeQuote {
  const amount = "25000000";
  return { ...quote(), originChainId: 5042, destinationChainId, amount, relayFee: "0.05", sourceGas: "0.001", amountOut: "9000000000000000", minimumAmountOut: "8990000000000000", approval: { token: ARC_USDC, spender: RELAY_DEPOSITORY, amount }, transaction: { chainId: 5042, to: RELAY_DEPOSITORY, value: "0", data: encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [ADDRESS, ARC_USDC, BigInt(amount), ORDER] }) } };
}

function baseUsdcQuote(): BridgeQuote {
  const q = arcQuote();
  return { ...q, originChainId: 8453, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC", amountOut: "24950000000000000000", minimumAmountOut: "24900000000000000000", sourceGas: "0.00001", approval: { ...q.approval!, token: BASE_USDC }, transaction: { ...q.transaction, chainId: 8453, data: encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [ADDRESS, BASE_USDC, BigInt(q.amount), ORDER] }) } };
}

function scenario(q = quote()) {
  const events: string[] = [];
  const state = { now: NOW, current: { address: q.address, originChainId: q.originChainId, destinationChainId: q.destinationChainId, amount: q.amount, ...(q.originAsset ? { originAsset: q.originAsset } : {}), ...(q.destinationAsset ? { destinationAsset: q.destinationAsset } : {}) } as BridgeQuoteRequest | null, transfer: null as TrackedBridgeTransfer | null, chainId: 8453, walletAddress: ADDRESS as Address | undefined, sends: 0 };
  const deps: DepositDependencies = {
    now: () => state.now,
    currentRequest: () => state.current,
    readWallet: async () => { events.push("wallet"); return { address: state.walletAddress, chainId: state.chainId }; },
    switchChain: async (id) => { events.push("switch"); state.chainId = id; },
    prepare: async () => { events.push("prepare"); return { gas: 100_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }; },
    readTransfer: () => state.transfer,
    saveTransfer: (next) => { events.push(`save:${next.status}`); state.transfer = next; },
    removeTransfer: () => { events.push("remove"); state.transfer = null; },
    send: async () => { events.push("send"); state.sends++; return HASH; },
    phase: (phase) => events.push(`phase:${phase}`),
  };
  return { q, deps, events, state };
}

test("amount parsing preserves integer precision and never rounds extra decimal places", () => {
  assert.equal(parseBridgeAmount(" 0.010000000000000001 "), 10_000_000_000_000_001n);
  assert.equal(parseBridgeAmount(".000000000000000001"), 1n);
  assert.equal(parseBridgeAmount("1."), 10n ** 18n);
  for (const bad of ["", "0", "0.0", "-1", "+1", "1e-3", "Infinity", "NaN", "1,000", "1.2.3", "0.0000000000000000001", "1.0000000000000000000", "9".repeat(80)]) assert.equal(parseBridgeAmount(bad), null, bad);
  assert.equal(bridgeRequest(undefined, 8453, "1", 4663), null);
  assert.equal(bridgeRequest(ADDRESS, 4663, "1", 8453)?.destinationChainId, 8453);
  assert.equal(bridgeRequestKey(bridgeRequest(ADDRESS, 8453, "0.01", 4663)), bridgeRequestKey(bridgeRequest(ADDRESS, 8453, ".0100", 4663)));
});

test("all six routes use the input currency precision, never native decimals for Arc ERC20", () => {
  for (const origin of BRIDGE_CHAIN_IDS) for (const destination of BRIDGE_CHAIN_IDS) {
    const request = bridgeRequest(ADDRESS, origin, origin === 5042 ? "1.000001" : "1.000000000000000001", destination);
    if (origin === destination) assert.equal(request, null);
    else {
      assert.equal(request?.amount, origin === 5042 ? "1000001" : "1000000000000000001");
      assert.equal(request?.destinationChainId, destination);
    }
  }
  assert.equal(bridgeRequest(ADDRESS, 5042, "1.0000001", 8453), null);
  assert.equal(parseBridgeAmount("0.000001", 6), 1n);
  assert.equal(parseBridgeAmount("0.0000001", 6), null);
  assert.equal(nativeSourceAmount(arcQuote()), 25n * 10n ** 18n);
  assert.notEqual(bridgeRequestKey(bridgeRequest(ADDRESS, 8453, "1", 4663)), bridgeRequestKey(bridgeRequest(ADDRESS, 8453, "1", 5042)));
});

test("network selections resolve collisions atomically and never reinterpret ETH amounts as USDC", () => {
  const initial = { originChainId: 8453, destinationChainId: 4663, amount: "0.01" } as const;
  const toArc = changeBridgeRoute(initial, { side: "destination", chainId: 5042 });
  assert.deepEqual(toArc, { ...initial, destinationChainId: 5042 });
  assert.deepEqual(changeBridgeRoute(initial, { side: "reverse" }), { originChainId: 4663, destinationChainId: 8453, amount: "0.01" });
  assert.deepEqual(changeBridgeRoute(initial, { side: "origin", chainId: 4663 }), { originChainId: 4663, destinationChainId: 8453, amount: "0.01" });
  assert.deepEqual(changeBridgeRoute(toArc, { side: "origin", chainId: 5042 }), { originChainId: 5042, destinationChainId: 8453, amount: "" });
  assert.deepEqual(changeBridgeRoute(toArc, { side: "reverse" }), { originChainId: 5042, destinationChainId: 8453, amount: "" });
  const fromArc = { originChainId: 5042, destinationChainId: 8453, amount: "25" } as const;
  assert.deepEqual(changeBridgeRoute(fromArc, { side: "destination", chainId: 5042 }), { originChainId: 8453, destinationChainId: 5042, amount: "" });
  assert.deepEqual(changeBridgeRoute(fromArc, { side: "destination", chainId: 4663 }), { ...fromArc, destinationChainId: 4663 });
  assert.deepEqual(changeBridgeRoute(fromArc, { side: "origin", chainId: 4663 }), { originChainId: 4663, destinationChainId: 8453, amount: "" });
});

test("asset-aware requests keep ETH and six-decimal USDC distinct and reject unsupported assets", () => {
  const usdc = bridgeRequest(ADDRESS, 8453, "25.000001", 5042, "USDC", "USDC");
  assert.equal(usdc?.amount, "25000001");
  assert.equal(usdc?.originAsset, "USDC");
  assert.equal(bridgeRequest(ADDRESS, 8453, "1.0000001", 5042, "USDC", "USDC"), null);
  assert.equal(bridgeRequest(ADDRESS, 8453, "1", 4663, "USDC", "USDC"), null);
  assert.equal(bridgeRequest(ADDRESS, 4663, "1", 8453, "USDC", "ETH"), null);
  assert.equal(bridgeRequest(ADDRESS, 5042, "1", 8453, "ETH", "USDC"), null);
  const legacy = bridgeRequest(ADDRESS, 8453, "25", 5042)!;
  assert.equal(legacy.amount, "25000000000000000000");
  assert.equal(bridgeRequestKey(legacy), bridgeRequestKey({ ...legacy, originAsset: "ETH", destinationAsset: "USDC" }));
  assert.notEqual(bridgeRequestKey(legacy), bridgeRequestKey({ ...legacy, originAsset: "USDC" }));
  const fromRh = bridgeRequest(ADDRESS, 4663, "1", 8453)!;
  assert.notEqual(bridgeRequestKey(fromRh), bridgeRequestKey({ ...fromRh, destinationAsset: "USDC" }));
});

test("asset selectors clear reinterpreted amounts and preserve supported tokens across chain changes", () => {
  const route = { originChainId: 8453, destinationChainId: 5042, originAsset: "ETH", destinationAsset: "USDC", amount: "1" } as const;
  const usdc = changeBridgeRoute(route, { side: "origin-asset", asset: "USDC" });
  assert.deepEqual(usdc, { ...route, originAsset: "USDC", amount: "" });
  const funded = { ...usdc, amount: "25" };
  assert.deepEqual(changeBridgeRoute(funded, { side: "reverse" }), { ...funded, originChainId: 5042, destinationChainId: 8453 });
  assert.deepEqual(changeBridgeRoute(funded, { side: "origin", chainId: 4663 }), { ...funded, originChainId: 4663, originAsset: "ETH", amount: "" });
  assert.deepEqual(changeBridgeRoute(route, { side: "destination-asset", asset: "ETH" }), route);
});

test("Base USDC uses exact pinned ERC20 deposits while reserving separate ETH gas", () => {
  const q = baseUsdcQuote();
  assert.equal(validateBridgeQuote(q, q, NOW), q);
  assert.equal(nativeSourceAmount(q), 0n);
  assert.equal(nativeSourceAmount(quote()), BigInt(amount));
  assert.equal(nativeSourceAmount(arcQuote()), 25n * 10n ** 18n);
  assert.deepEqual(bridgeGasBudget(0n, 300n, 100n, 2n, 50n), { gas: 120n, reserve: 300n });
  assert.throws(() => bridgeGasBudget(0n, 299n, 100n, 2n, 50n), /Not enough ETH/);
  for (const changed of [
    { ...q, originAsset: "ETH" as const }, { ...q, approval: undefined },
    { ...q, approval: { ...q.approval!, token: ARC_USDC } },
    { ...q, transaction: { ...q.transaction, value: q.amount } },
    { ...q, transaction: { ...q.transaction, data: arcQuote().transaction.data } },
  ]) assert.throws(() => validateBridgeQuote(changed, q, NOW));
  const unlimited = ((1n << 256n) - 1n).toString();
  const unlimitedQuote: BridgeQuote = { ...q, amount: unlimited, approval: { ...q.approval!, amount: unlimited }, transaction: { ...q.transaction, data: encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [ADDRESS, BASE_USDC, BigInt(unlimited), ORDER] }) } };
  assert.throws(() => validateBridgeQuote(unlimitedQuote, unlimitedQuote, NOW), /Unlimited USDC approvals/);
});

test("asset changes across awaited preflight cancel a reviewed deposit", async () => {
  const s = scenario(baseUsdcQuote());
  s.deps.prepare = async () => { s.state.current = { ...s.state.current!, originAsset: "ETH" }; return { gas: 100_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }; };
  await assert.rejects(submitBridgeDeposit(s.q, s.deps), /changed/);
  assert.equal(s.state.sends, 0);
});

test("version-three journals preserve asset choices without reinterpreting legacy native transfers", async () => {
  const s = scenario(baseUsdcQuote());
  await submitBridgeDeposit(s.q, s.deps);
  const saved = s.state.transfer!;
  assert.equal(JSON.parse(serializeTransfer(saved)).version, 3);
  assert.deepEqual(parseStoredTransfer(serializeTransfer(saved), ADDRESS), saved);
  assert.equal(saved.originAsset, "USDC");
  const oneExplicit = { ...saved, destinationAsset: undefined };
  assert.equal(parseStoredTransfer(serializeTransfer(oneExplicit), ADDRESS).destinationAsset, "USDC");
  for (const mutation of [{ version: 1 }, { version: 2 }, { originAsset: "ETH" }, { originAsset: undefined }, { destinationAsset: undefined }, { depositKind: undefined }, { depositData: arcQuote().transaction.data }]) assert.throws(() => parseStoredTransfer(JSON.stringify({ ...saved, version: 3, ...mutation }), ADDRESS));
  const legacy = tracked();
  const restored = parseStoredTransfer(serializeTransfer(legacy), ADDRESS);
  assert.equal(restored.originAsset, undefined);
  assert.equal(restored.amount, amount);
  assert.throws(() => parseStoredTransfer(JSON.stringify({ ...legacy, version: 1, originAsset: "USDC" }), ADDRESS));
});

test("Base USDC recovery rejects Arc tokens and appended event data", () => {
  const q = baseUsdcQuote();
  const transfer: TrackedBridgeTransfer = { ...tracked(), originAsset: "USDC", destinationAsset: "USDC", destinationChainId: 5042, amount: q.amount, depositKind: "erc20", depositData: q.transaction.data };
  const log = { address: RELAY_DEPOSITORY, topics: encodeEventTopics({ abi: ERC20_DEPOSIT_EVENT, eventName: "RelayErc20Deposit" }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }], [ADDRESS, BASE_USDC, BigInt(q.amount), ORDER]) };
  assert.equal(hasMatchingDepositEvent(transfer, { status: "success", logs: [log] }), true);
  assert.equal(hasMatchingDepositEvent(transfer, { status: "success", logs: [{ ...log, data: `${log.data}00` }] }), false);
  const wrongToken = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }], [ADDRESS, ARC_USDC, BigInt(q.amount), ORDER]);
  assert.equal(hasMatchingDepositEvent(transfer, { status: "success", logs: [{ ...log, data: wrongToken }] }), false);
});

test("quote permits only native ETH deposit bound to reviewed wallet, amount and chain", () => {
  const q = quote();
  assert.equal(validateBridgeQuote(q, q, NOW), q);
  // Relay's protocol orderId and status requestId are distinct identifiers.
  assert.notEqual(ORDER, REQUEST);
  const altered: BridgeQuote[] = [
    { ...q, address: OTHER }, { ...q, amount: "2" }, { ...q, destinationChainId: 8453 },
    { ...q, transaction: { ...q.transaction, chainId: 4663 } },
    { ...q, transaction: { ...q.transaction, value: "2" } },
    { ...q, transaction: { ...q.transaction, to: OTHER } },
    { ...q, transaction: { ...q.transaction, data: "0x" } },
    { ...q, transaction: { ...q.transaction, data: `${q.transaction.data}00` } },
    { ...q, transaction: { ...q.transaction, data: encodeFunctionData({ abi: NATIVE_DEPOSIT_ABI, functionName: "depositNative", args: [OTHER, ORDER] }) } },
    { ...q, transaction: { ...q.transaction, data: encodeFunctionData({ abi: NATIVE_DEPOSIT_ABI, functionName: "depositNative", args: [ADDRESS, `0x${"0".repeat(64)}`] }) } },
    { ...q, expiresAt: NOW }, { ...q, expiresAt: NOW + 121_000 },
    { ...q, minimumAmountOut: "999999999999999999" }, { ...q, amountOut: "-1" },
  ];
  for (const changed of altered) assert.throws(() => validateBridgeQuote(changed, q, NOW));
});

test("ETH/USDC quote amounts are not compared as if they were the same currency", () => {
  const base = quote();
  const toArc: BridgeQuote = { ...base, destinationChainId: 5042, amountOut: "24000000000000000000", minimumAmountOut: "23900000000000000000" };
  assert.equal(validateBridgeQuote(toArc, toArc, NOW), toArc);
  const fromArc = arcQuote(4663);
  assert.equal(validateBridgeQuote(fromArc, fromArc, NOW), fromArc);
  assert.throws(() => validateBridgeQuote({ ...toArc, destinationChainId: 5042002 }, toArc, NOW), /route/);
});

test("Arc only accepts pinned six-decimal USDC with exact approval and four-argument deposit", () => {
  for (const destination of [8453, 4663] as const) {
    const q = arcQuote(destination);
    assert.equal(validateBridgeQuote(q, q, NOW), q);
    for (const changed of [
      { ...q, approval: undefined },
      { ...q, approval: { ...q.approval!, token: OTHER } },
      { ...q, approval: { ...q.approval!, spender: OTHER } },
      { ...q, approval: { ...q.approval!, amount: "999999999999999999999999" } },
      { ...q, relayFee: "0.0000001" },
      { ...q, transaction: { ...q.transaction, value: q.amount } },
      { ...q, transaction: { ...q.transaction, to: OTHER } },
      { ...q, transaction: { ...q.transaction, data: quote().transaction.data } },
      { ...q, transaction: { ...q.transaction, data: `${q.transaction.data}00` } },
      { ...q, transaction: { ...q.transaction, data: encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [OTHER, ARC_USDC, BigInt(q.amount), ORDER] }) } },
      { ...q, transaction: { ...q.transaction, data: encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [ADDRESS, OTHER, BigInt(q.amount), ORDER] }) } },
      { ...q, transaction: { ...q.transaction, data: encodeFunctionData({ abi: ERC20_DEPOSIT_ABI, functionName: "depositErc20", args: [ADDRESS, ARC_USDC, 1n, ORDER] }) } },
    ]) assert.throws(() => validateBridgeQuote(changed, q, NOW));
  }
  assert.throws(() => validateBridgeQuote({ ...quote(), approval: arcQuote().approval }, quote(), NOW), /approval/);
});

test("Arc deposits journal version two separately from approval and preserve exact calldata", async () => {
  const s = scenario(arcQuote());
  const result = await submitBridgeDeposit(s.q, s.deps);
  assert.equal(result.kind, "sent");
  const transfer = s.state.transfer!;
  assert.equal(transfer.depositKind, "erc20");
  assert.equal(transfer.amount, "25000000");
  assert.equal(JSON.parse(serializeTransfer(transfer)).version, 2);
  assert.deepEqual(parseStoredTransfer(serializeTransfer(transfer), ADDRESS), transfer);
  assert.equal(isMatchingSourceDeposit(transfer, { from: ADDRESS, to: RELAY_DEPOSITORY, input: s.q.transaction.data, value: 0n }), true);
  assert.equal(isMatchingSourceDeposit(transfer, { from: ADDRESS, to: RELAY_DEPOSITORY, input: s.q.transaction.data, value: BigInt(s.q.amount) }), false);
  assert.throws(() => parseStoredTransfer(JSON.stringify({ ...transfer, version: 1 }), ADDRESS));
  assert.throws(() => parseStoredTransfer(serializeTransfer({ ...transfer, amount: "1" }), ADDRESS));
});

test("Arc smart-wallet recovery requires pinned ERC20 event amount, wallet and order", () => {
  const q = arcQuote();
  const transfer: TrackedBridgeTransfer = { ...tracked(), originChainId: 5042, destinationChainId: 8453, amount: q.amount, depositKind: "erc20", depositData: q.transaction.data };
  const log = { address: RELAY_DEPOSITORY, topics: encodeEventTopics({ abi: ERC20_DEPOSIT_EVENT, eventName: "RelayErc20Deposit" }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }], [ADDRESS, ARC_USDC, BigInt(q.amount), ORDER]) };
  assert.equal(hasMatchingDepositEvent(transfer, { status: "success", logs: [log] }), true);
  for (const args of [[OTHER, ARC_USDC, BigInt(q.amount), ORDER], [ADDRESS, OTHER, BigInt(q.amount), ORDER], [ADDRESS, ARC_USDC, 1n, ORDER], [ADDRESS, ARC_USDC, BigInt(q.amount), REQUEST]] as const) {
    const changed = { ...log, data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }], args) };
    assert.equal(hasMatchingDepositEvent(transfer, { status: "success", logs: [changed] }), false);
  }
  assert.equal(hasMatchingDepositEvent(transfer, { status: "reverted", logs: [log] }), false);
});

test("fee and total-impact guards reject excessive loss, nonnumeric amounts and relayer fees above 5%", () => {
  const q = quote();
  for (const impact of ["-5", "0", "1.25", "100"]) assert.doesNotThrow(() => validateBridgeQuote({ ...q, totalImpactPercent: impact }, q, NOW));
  for (const impact of ["-5.000000000000000001", "-6", "101", "NaN", "Infinity", "1e2", "", "--1"]) assert.throws(() => validateBridgeQuote({ ...q, totalImpactPercent: impact }, q, NOW), /impact/);
  assert.doesNotThrow(() => validateBridgeQuote({ ...q, relayFee: "0.0005" }, q, NOW));
  for (const relayFee of ["0.000500000000000001", "0.01", "0.02", "-1", "1e-3", "Infinity", "9".repeat(80)]) assert.throws(() => validateBridgeQuote({ ...q, relayFee }, q, NOW), /fee/);
  assert.throws(() => validateBridgeQuote({ ...q, sourceGas: "9".repeat(80) }, q, NOW), /fee/);
  assert.throws(() => validateBridgeQuote({ ...q, totalImpactPercent: undefined }, q, NOW), /impact/);
});

test("fee rejection diagnostics bind the request and keep Arc input6 separate from native gas18", () => {
  const request = bridgeRequest(ADDRESS, 5042, "1", 8453, "USDC", "ETH")!;
  const rejected: BridgeQuoteRejection = { ...request, reason: "relay-fee", relayFee: "0.059123", relayFeePercent: "5.9123", sourceGas: "0.003000000000000001", totalImpactPercent: "-6.24" };
  assert.deepEqual(parseBridgeQuoteRejection(rejected, request), rejected);
  assert.notEqual(parseBridgeQuoteRejection(rejected, request), rejected);
  for (const change of [
    { address: OTHER }, { amount: "2000000" }, { destinationChainId: 4663 }, { originChainId: 8453 },
    { originAsset: "ETH" }, { originAsset: null }, { destinationAsset: "USDC" }, { destinationAsset: null },
    { reason: "total-impact" }, { relayFeePercent: "5" }, { relayFeePercent: 5.9123 },
    { relayFee: "0.0591231" }, { relayFee: "1e-1" }, { relayFee: "-0.1" }, { relayFee: "1" },
    { sourceGas: "0.0000000000000000001" }, { sourceGas: "9".repeat(80) },
    { totalImpactPercent: "-100.01" }, { totalImpactPercent: "+1" }, { totalImpactPercent: "NaN" },
    { transaction: arcQuote().transaction }, { approval: arcQuote().approval }, { requestId: REQUEST },
  ]) assert.equal(parseBridgeQuoteRejection({ ...rejected, ...change }, request), null, JSON.stringify(change));
  for (const invalid of [null, [], "bad", {}, { ...rejected, relayFee: undefined }]) assert.equal(parseBridgeQuoteRejection(invalid, request), null);
  assert.throws(() => validateBridgeQuote(rejected, request, NOW));
});

test("total-impact rejections are display-only and neither lower nor bypass either 5% guard", () => {
  const request = bridgeRequest(ADDRESS, 5042, "1", 4663)!;
  const rejected: BridgeQuoteRejection = { ...request, reason: "total-impact", relayFee: "0.05", relayFeePercent: "5", sourceGas: "0.001", totalImpactPercent: "-5.000000000000000001" };
  assert.deepEqual(parseBridgeQuoteRejection(rejected, request), rejected);
  assert.equal(parseBridgeQuoteRejection({ ...rejected, totalImpactPercent: "-5" }, request), null);
  assert.equal(parseBridgeQuoteRejection({ ...rejected, totalImpactPercent: "100" }, request), null);
  assert.equal(parseBridgeQuoteRejection({ ...rejected, relayFee: "0.050001", relayFeePercent: "5.0001" }, request), null);
  const ethRequest = bridgeRequest(ADDRESS, 8453, "0.01", 5042)!;
  const ethRejected: BridgeQuoteRejection = { ...ethRequest, reason: "relay-fee", relayFee: "0.000500000000000001", relayFeePercent: "5.000001", sourceGas: "0.000000000000000001", totalImpactPercent: "0" };
  assert.deepEqual(parseBridgeQuoteRejection(ethRejected, ethRequest), ethRejected);
});

test("gas preflight reserves fresh fees and rejects spending the full native balance", () => {
  const budget = bridgeGasBudget(1000n, 10_000n, 100n, 2n, 50n);
  assert.deepEqual(budget, { gas: 120n, reserve: 300n });
  assert.throws(() => bridgeGasBudget(1000n, 1299n, 100n, 2n, 50n), /Not enough ETH/);
  assert.throws(() => bridgeGasBudget(1000n, 1000n, 100n, 2n), /Not enough ETH/);
  assert.throws(() => bridgeGasBudget(1000n, 10000n, 0n, 2n), /estimate/);
  assert.throws(() => bridgeGasBudget(1000n, 1000n, 100n, 2n, 0n, "USDC"), /Not enough USDC/);
});

test("submission persists recovery before wallet send and binds the returned source hash", async () => {
  const { q, deps, events, state } = scenario();
  const result = await submitBridgeDeposit(q, deps);
  assert.equal(result.kind, "sent");
  assert.equal(state.sends, 1);
  assert.ok(events.indexOf("save:uncertain") < events.indexOf("send"));
  assert.equal(state.transfer?.sourceHash, HASH);
  assert.equal(state.transfer?.status, "pending");
  assert.deepEqual(state.transfer?.destinationHashes, []);
});

test("chain switching is explicit and wallet account/network are rechecked after preflight", async () => {
  const switched = scenario();
  switched.state.chainId = 4663;
  await submitBridgeDeposit(switched.q, switched.deps);
  assert.ok(switched.events.indexOf("switch") < switched.events.indexOf("prepare"));
  assert.equal(switched.events.filter((event) => event === "wallet").length, 2);

  for (const change of ["account", "chain"] as const) {
    const s = scenario();
    s.deps.prepare = async () => {
      if (change === "account") s.state.walletAddress = OTHER;
      else s.state.chainId = 4663;
      return { gas: 1n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
    };
    await assert.rejects(submitBridgeDeposit(s.q, s.deps), /account or network changed/);
    assert.equal(s.state.sends, 0);
    assert.equal(s.state.transfer, null);
  }
});

test("account/input edits and quote expiration during awaits cancel before any wallet prompt", async () => {
  for (const change of ["account", "amount", "destination", "expiry"] as const) {
    const s = scenario();
    s.deps.prepare = async () => {
      if (change === "account") s.state.current = bridgeRequest(OTHER, 8453, "0.01", 4663);
      else if (change === "amount") s.state.current = bridgeRequest(ADDRESS, 8453, "0.02", 4663);
      else if (change === "destination") s.state.current = bridgeRequest(ADDRESS, 8453, "0.01", 5042);
      else s.state.now = s.q.expiresAt;
      return { gas: 1n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
    };
    await assert.rejects(submitBridgeDeposit(s.q, s.deps), /changed|expired/);
    assert.equal(s.state.sends, 0);
    assert.equal(s.state.transfer, null);
  }
});

test("existing and newly observed pending records prevent a second deposit", async () => {
  const existing = scenario();
  existing.state.transfer = tracked();
  await assert.rejects(submitBridgeDeposit(existing.q, existing.deps), /already being tracked/);
  assert.deepEqual(existing.events, []);
  const during = scenario();
  during.deps.prepare = async () => {
    during.state.transfer = tracked();
    return { gas: 1n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
  };
  await assert.rejects(submitBridgeDeposit(during.q, during.deps), /now being tracked/);
  assert.equal(during.state.sends, 0);
});

test("failed preflight or durable storage never requests a signature", async () => {
  const preflight = scenario();
  preflight.deps.prepare = async () => { throw new Error("RPC unavailable"); };
  await assert.rejects(submitBridgeDeposit(preflight.q, preflight.deps), /RPC unavailable/);
  assert.equal(preflight.state.sends, 0);
  const storage = scenario();
  storage.deps.saveTransfer = () => { throw new Error("quota exceeded"); };
  await assert.rejects(submitBridgeDeposit(storage.q, storage.deps), /No transaction was requested/);
  assert.equal(storage.state.sends, 0);
  assert.equal(storage.state.transfer, null);
});

test("only explicit wallet rejection clears the unsent record", async () => {
  const s = scenario();
  s.deps.send = async () => { throw { cause: { code: 4001 } }; };
  const result = await submitBridgeDeposit(s.q, s.deps);
  assert.equal(result.kind, "rejected");
  assert.equal(s.state.transfer, null);
  assert.equal(isWalletRejection({ code: "ACTION_REJECTED" }), true);
  assert.equal(isWalletRejection(new Error("User rejected? Network unavailable")), false);
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(isWalletRejection(cyclic), false);
});

test("ambiguous submission remains recoverable without hash and cannot be resubmitted", async () => {
  const s = scenario();
  s.deps.send = async () => { s.state.sends++; throw new Error("RPC timeout after broadcast"); };
  const result = await submitBridgeDeposit(s.q, s.deps);
  assert.equal(result.kind, "uncertain");
  assert.equal(s.state.transfer?.status, "uncertain");
  assert.equal(s.state.transfer?.sourceHash, undefined);
  await assert.rejects(submitBridgeDeposit(s.q, s.deps), /already being tracked/);
  assert.equal(s.state.sends, 1);
  assert.equal(parseStoredTransfer(serializeTransfer(s.state.transfer!), ADDRESS).requestId, REQUEST);
});

test("a missing wallet hash is uncertain, and a post-send storage failure does not initiate another send", async () => {
  const missing = scenario();
  missing.deps.send = async () => "0x";
  assert.equal((await submitBridgeDeposit(missing.q, missing.deps)).kind, "uncertain");
  const after = scenario();
  const save = after.deps.saveTransfer;
  after.deps.saveTransfer = (next) => {
    if (next.sourceHash) throw new Error("storage became unavailable");
    save(next);
  };
  assert.equal((await submitBridgeDeposit(after.q, after.deps)).kind, "sent");
  assert.equal(after.state.sends, 1);
  assert.equal(after.state.transfer?.status, "uncertain");
});

test("provider status alone settles success/refund, while waiting cannot resolve an ambiguous send", () => {
  const unknown = tracked();
  assert.equal(mergeBridgeStatus(unknown, { status: "waiting", inTxHashes: [], txHashes: [] }).status, "uncertain");
  const pending = mergeBridgeStatus({ ...unknown, sourceHash: HASH }, { status: "pending", inTxHashes: [HASH], txHashes: [] });
  assert.equal(pending.sourceHash, HASH);
  assert.equal(transferIsTerminal(pending), false);
  for (const status of ["success", "refund", "failure"] as const) {
    const final = mergeBridgeStatus(pending, { status, inTxHashes: [HASH], txHashes: [DEST_HASH] });
    assert.equal(transferIsTerminal(final), true);
    assert.deepEqual(final.destinationHashes, [DEST_HASH]);
    assert.equal(mergeBridgeStatus(final, { status: "pending", inTxHashes: [], txHashes: [] }), final);
  }
  assert.throws(() => validateBridgeStatus({ status: "failed-network-request", inTxHashes: [], txHashes: [] }));
  assert.throws(() => validateBridgeStatus({ status: "success", inTxHashes: ["not-a-hash"], txHashes: [] }));
  assert.throws(() => mergeBridgeStatus(pending, { status: "success", inTxHashes: [DEST_HASH], txHashes: [HASH] }), /not yet been matched/);
  assert.throws(() => mergeBridgeStatus(unknown, { status: "success", inTxHashes: [HASH], txHashes: [DEST_HASH] }), /not yet been matched/);
  assert.throws(() => mergeBridgeStatus(pending, { status: "refund", inTxHashes: [], txHashes: [] }), /not yet been matched/);
});

test("recovering an unknown source hash requires the exact recorded native deposit on-chain", () => {
  const transfer = tracked();
  const transaction = { from: ADDRESS, to: RELAY_DEPOSITORY, value: BigInt(amount), input: quote().transaction.data };
  assert.equal(isMatchingSourceDeposit(transfer, transaction), true);
  assert.equal(isMatchingSourceDeposit(transfer, { ...transaction, from: OTHER }), false);
  assert.equal(isMatchingSourceDeposit(transfer, { ...transaction, to: OTHER }), false);
  assert.equal(isMatchingSourceDeposit(transfer, { ...transaction, value: 1n }), false);
  assert.equal(isMatchingSourceDeposit(transfer, { ...transaction, input: "0x" }), false);
  assert.equal(isMatchingSourceDeposit({ ...transfer, depositData: undefined }, transaction), false);
});

test("smart-wallet recovery binds the canonical deposit event to wallet, amount and protocol order", () => {
  const transfer = tracked();
  const log = {
    address: RELAY_DEPOSITORY,
    topics: encodeEventTopics({ abi: NATIVE_DEPOSIT_EVENT, eventName: "RelayNativeDeposit" }) as Hex[],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [ADDRESS, BigInt(amount), ORDER]),
  };
  assert.equal(hasMatchingDepositEvent(transfer, { status: "success", logs: [log] }), true);
  assert.equal(hasMatchingDepositEvent(transfer, { status: "reverted", logs: [log] }), false);
  assert.equal(hasMatchingDepositEvent(transfer, { status: "success", logs: [{ ...log, address: OTHER }] }), false);
  assert.equal(hasMatchingDepositEvent({ ...transfer, address: OTHER }, { status: "success", logs: [log] }), false);
  assert.equal(hasMatchingDepositEvent({ ...transfer, amount: "1" }, { status: "success", logs: [log] }), false);
  const wrongOrder = { ...log, data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [ADDRESS, BigInt(amount), REQUEST]) };
  assert.equal(hasMatchingDepositEvent(transfer, { status: "success", logs: [wrongOrder] }), false);
});

function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test("transfer storage restores per wallet including an unknown transaction hash", () => {
  const storage = memoryStorage();
  const store = createBridgeTransferStore(() => storage);
  const transfer = tracked();
  store.save(transfer);
  const restored = createBridgeTransferStore(() => storage);
  assert.deepEqual(restored.read(ADDRESS), { ...transfer, sourceHash: undefined });
  assert.equal(restored.read(OTHER), null);
  assert.equal(restored.getServerSnapshot().transfers[ADDRESS.toLowerCase()], undefined);
  store.remove(ADDRESS);
  assert.equal(restored.read(ADDRESS), null);
});

test("version-one recovery keeps old Base/Robinhood records and accepts every distinct Arc route", () => {
  for (const originChainId of BRIDGE_CHAIN_IDS) for (const destinationChainId of BRIDGE_CHAIN_IDS) {
    if (originChainId === destinationChainId) continue;
    const transfer = { ...tracked(), originChainId, destinationChainId };
    assert.deepEqual(parseStoredTransfer(serializeTransfer(transfer), ADDRESS), { ...transfer, sourceHash: undefined });
  }
});

test("corrupt or wallet-mismatched records fail closed, never silently resetting pending funds", () => {
  const storage = memoryStorage();
  const store = createBridgeTransferStore(() => storage);
  storage.setItem(bridgeStorageKey(ADDRESS), "not-json");
  assert.throws(() => store.read(ADDRESS), /storage is unavailable or unreadable/);
  storage.setItem(bridgeStorageKey(ADDRESS), serializeTransfer({ ...tracked(), address: OTHER }));
  assert.throws(() => store.read(ADDRESS));
  assert.throws(() => parseStoredTransfer(serializeTransfer({ ...tracked(), amount: "-1" }), ADDRESS));
  assert.throws(() => parseStoredTransfer(serializeTransfer({ ...tracked(), destinationChainId: 8453 }), ADDRESS));
});

test("storage writes must be durable; a later failure retains recovery details in memory", () => {
  const noop = createBridgeTransferStore(() => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }));
  assert.throws(() => noop.save(tracked()), /Could not save/);
  assert.equal(noop.getSnapshot().transfers[ADDRESS.toLowerCase()]?.requestId, REQUEST);
  const blocked = createBridgeTransferStore(() => { throw new Error("blocked"); });
  assert.throws(() => blocked.read(ADDRESS));
  assert.throws(() => blocked.save({ ...tracked(), sourceHash: HASH }));
  assert.equal(blocked.getSnapshot().transfers[ADDRESS.toLowerCase()]?.sourceHash, HASH);
  assert.match(blocked.getSnapshot().errors[ADDRESS.toLowerCase()] ?? "", /Keep this page open/);
});

test("fresh storage reads preserve an in-memory source hash without overwriting a newer request", () => {
  const storage = memoryStorage();
  const store = createBridgeTransferStore(() => storage);
  const initial = tracked();
  store.save(initial);
  store.remember({ ...initial, sourceHash: HASH, status: "pending" });
  assert.equal(store.read(ADDRESS)?.sourceHash, HASH);
  assert.equal(store.read(ADDRESS)?.status, "pending");
  storage.setItem(bridgeStorageKey(ADDRESS), serializeTransfer({ ...initial, requestId: ORDER }));
  assert.equal(store.read(ADDRESS)?.requestId, ORDER);
  assert.equal(store.read(ADDRESS)?.sourceHash, undefined);
});

test("confirmed source-revert recovery survives a reload without claiming a provider refund", () => {
  const transfer: TrackedBridgeTransfer = { ...tracked(), sourceHash: HASH, status: "failure", failureReason: "source-reverted" };
  const restored = parseStoredTransfer(serializeTransfer(transfer), ADDRESS);
  assert.equal(restored.failureReason, "source-reverted");
  assert.equal(restored.status, "failure");
  assert.equal(transferIsTerminal(restored), true);
});

test("quote validity is anchored on this device's clock at request time, never on the server epoch", () => {
  const skewed = { ...quote(), expiresAt: NOW - 600_000, ttlMs: 45_000 }; // a server 10 minutes "behind" this phone
  const anchored = anchorQuoteExpiry(skewed, NOW) as BridgeQuote;
  assert.equal(anchored.expiresAt, NOW + 45_000);
  assert.equal(validateBridgeQuote(anchored, quote(), NOW).requestId, REQUEST);
  assert.throws(() => validateBridgeQuote(skewed, quote(), NOW), /expired/);
  for (const ttlMs of [undefined, "45000", -1, 120_001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => anchorQuoteExpiry({ ...quote(), ttlMs }, NOW), /quote validity/);
  }
  assert.equal(anchorQuoteExpiry(null, NOW), null); // non-objects fall through to the quote validator
});

test("linked timeout signal aborts on the parent, on the timer, and never needs AbortSignal.any", async () => {
  const parent = new AbortController();
  const signal = linkedTimeoutSignal(parent.signal, 60_000);
  assert.equal(signal.aborted, false);
  parent.abort(new Error("gone"));
  assert.equal(signal.aborted, true);
  assert.equal((signal.reason as Error).message, "gone");
  // A timeout also detaches from the parent, so a long-lived parent never collects one listener per request.
  const owner = new AbortController();
  const detached: unknown[] = [];
  const remove = owner.signal.removeEventListener.bind(owner.signal);
  owner.signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
    detached.push(listener);
    remove(type, listener, options);
  }) as typeof owner.signal.removeEventListener;
  const timed = linkedTimeoutSignal(owner.signal, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(timed.aborted, true);
  assert.equal((timed.reason as DOMException).name, "TimeoutError");
  assert.equal(detached.length, 1);
  owner.abort(new Error("later"));
  assert.equal((timed.reason as DOMException).name, "TimeoutError");
  const already = new AbortController();
  already.abort();
  assert.equal(linkedTimeoutSignal(already.signal, 60_000).aborted, true);
  assert.equal(linkedTimeoutSignal(undefined, 60_000).aborted, false);
});

test("a deposit that never happened can be discarded only after the wait, with fresh provider and chain evidence", () => {
  const unsent: TrackedBridgeTransfer = { address: ADDRESS, originChainId: 8453, destinationChainId: 4663, amount, requestId: REQUEST, destinationHashes: [], status: "uncertain", createdAt: NOW };
  const waiting = { status: "waiting" as const, inTxHashes: [], txHashes: [] };
  const later = NOW + DISCARD_AFTER_MS;
  const fresh = { requestId: REQUEST, status: waiting, sourceMined: false, observedAt: later };
  assert.equal(transferCanDiscard(unsent, fresh, later), true);
  assert.equal(transferCanDiscard({ ...unsent, sourceHash: HASH, status: "pending" }, fresh, later), true); // wallet hash dropped, never mined
  assert.equal(transferCanDiscard(unsent, fresh, later - 1), false); // too early
  assert.equal(transferCanDiscard(unsent, { ...fresh, observedAt: later - 61_000 }, later), false); // stale observation
  assert.equal(transferCanDiscard(unsent, { ...fresh, observedAt: later + 1 }, later), false); // observation from the future
  assert.equal(transferCanDiscard(unsent, { ...fresh, sourceMined: true }, later), false); // receipt exists or RPC unknown
  assert.equal(transferCanDiscard(unsent, { ...fresh, requestId: ORDER }, later), false); // another transfer's status
  assert.equal(transferCanDiscard(unsent, null, later), false);
  for (const status of ["depositing", "pending", "submitted", "delayed", "success", "refund", "failure"] as const) {
    assert.equal(transferCanDiscard(unsent, { ...fresh, status: { ...waiting, status } }, later), false, status);
  }
  assert.equal(transferCanDiscard(unsent, { ...fresh, status: { ...waiting, inTxHashes: [HASH] } }, later), false); // provider saw a deposit
  assert.equal(transferCanDiscard(unsent, { ...fresh, status: { ...waiting, txHashes: [DEST_HASH] } }, later), false);
  assert.equal(transferCanDiscard({ ...unsent, status: "success" }, fresh, later), false); // settled records use reset instead
  assert.equal(transferCanDiscard(null, fresh, later), false);
});

test("a sped-up or cancelled deposit adopts Relay's hash only when the wallet's own hash is unmined and no longer reported", () => {
  const base: TrackedBridgeTransfer = { address: ADDRESS, originChainId: 8453, destinationChainId: 4663, amount, requestId: REQUEST, destinationHashes: [], status: "pending", createdAt: NOW, sourceHash: HASH };
  const status = (inTxHashes: Hex[]) => ({ status: "success" as const, inTxHashes, txHashes: [DEST_HASH] });
  const REPLACEMENT = `0x${"e".repeat(64)}` as Hex;
  // Wallet returned no hash: adopt whatever Relay reports, then verify it on-chain.
  assert.equal(replacementSourceHash({ ...base, sourceHash: undefined, status: "uncertain" }, status([REPLACEMENT]), false), REPLACEMENT);
  assert.equal(replacementSourceHash({ ...base, sourceHash: undefined, status: "uncertain" }, status([]), false), null);
  // Speed-up: wallet hash dropped, Relay saw the replacement.
  assert.equal(replacementSourceHash(base, status([REPLACEMENT]), true), REPLACEMENT);
  assert.equal(replacementSourceHash(base, status([REPLACEMENT.toUpperCase().replace("0X", "0x") as Hex]), true), REPLACEMENT.toUpperCase().replace("0X", "0x"));
  // Never swap a mined wallet hash, a wallet hash Relay still reports, or when Relay reports nothing else.
  assert.equal(replacementSourceHash(base, status([REPLACEMENT]), false), null);
  assert.equal(replacementSourceHash(base, status([HASH, REPLACEMENT]), true), null);
  assert.equal(replacementSourceHash(base, status([HASH.toUpperCase().replace("0X", "0x") as Hex]), true), null);
  assert.equal(replacementSourceHash(base, status([]), true), null);
  // Once adopted, the provider's settled state applies to the same order.
  const adopted = { ...base, sourceHash: REPLACEMENT };
  assert.equal(mergeBridgeStatus(adopted, status([REPLACEMENT])).status, "success");
  assert.deepEqual(mergeBridgeStatus(adopted, status([REPLACEMENT])).destinationHashes, [DEST_HASH]);
  assert.throws(() => mergeBridgeStatus(base, status([REPLACEMENT])), /not yet been matched/); // without adoption it stays blocked
});

test("a wallet change clears an in-flight quote lock but leaves wallet prompts untouched", () => {
  assert.deepEqual(activityAfterWalletChange({ key: "k", phase: "quoting" }), { key: "", phase: "idle" });
  for (const phase of ["idle", "switching", "confirming"] as const) {
    const activity = { key: "k", phase };
    assert.equal(activityAfterWalletChange(activity), activity);
  }
});

test("bridge error copy surfaces the provider's own text behind viem's generic wrappers", () => {
  const rpc = (code: number, message: string) => new RpcRequestError({ body: {}, error: { code, message }, url: "http://wallet" });
  assert.equal(bridgeErrorMessage(new UnknownRpcError(rpc(4902, "Unrecognized chain ID \"0x13b2\". Try adding the chain using wallet_addEthereumChain first.")), "x"), "Your wallet doesn't have this network yet. Add it in the wallet, then try again.");
  assert.equal(bridgeErrorMessage(new UnknownRpcError(rpc(-32099, "node is syncing")), "x"), "An unknown RPC error occurred. node is syncing");
  assert.equal(bridgeErrorMessage(new UnknownRpcError(rpc(-32016, "over rate limit")), "x"), "The network is busy right now. Try again in a moment.");
  assert.match(bridgeErrorMessage(new UnknownRpcError(rpc(-32099, "y".repeat(300))), "x"), /^An unknown RPC error occurred\. y{160}…$/);
  assert.equal(bridgeErrorMessage(new HttpRequestError({ url: "http://127.0.0.1:8545", details: "fetch failed" }), "x"), "HTTP request failed. fetch failed");
  assert.equal(bridgeErrorMessage(new UserRejectedRequestError(new Error("User rejected the request.")), "x"), "You cancelled in your wallet.");
  assert.equal(bridgeErrorMessage(new SwitchChainError(new UserRejectedRequestError(new Error("User rejected the request."))), "x"), "You cancelled in your wallet.");
  assert.equal(bridgeErrorMessage(new InsufficientFundsError({ cause: new Error("insufficient funds for gas * price + value") }), "x", "USDC"), "Not enough USDC for this transaction plus gas.");
  assert.equal(bridgeErrorMessage(new Error("plain"), "fallback"), "plain");
  assert.equal(bridgeErrorMessage("string", "fallback"), "fallback");
});
