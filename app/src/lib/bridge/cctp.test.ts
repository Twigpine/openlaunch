import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, pad, parseAbi, type Address, type Hex } from "viem";
import { CCTP_BURN_ABI, CCTP_BURN_EVENT, CCTP_FORWARD_HOOK, CCTP_TOKEN_MESSENGER, cctpAmountOut, cctpBurnData, cctpBurnFee, cctpRoute, isCctpBurnLog } from "./cctp";
import { bridgeStatusUrl, CCTP_SCAN_BLOCKS, findCctpBurn, hasMatchingDepositEvent, isMatchingSourceDeposit, parseStoredTransfer, serializeTransfer, submitBridgeDeposit, validateBridgeQuote, type DepositDependencies, type TrackedBridgeTransfer } from "./client";
import { ARBITRUM_USDC, ARC_USDC, BASE_USDC, ETHEREUM_USDC, OPTIMISM_USDC, bridgeFeePercent, type BridgeQuote, type BridgeQuoteRequest } from "./types";

const WALLET = "0x6376ca7e839f1c3dd7f23cc8a1a58329f60db125" as const;
const OTHER = "0x1111111111111111111111111111111111111111" as const;
const ZERO_WORD = `0x${"0".repeat(64)}` as Hex;
const HASH = `0x${"ab".repeat(32)}` as Hex;
// Arbitrum USDC to Base USDC: 25 USDC, the fee Circle quoted for Fast plus its forward
const REQUEST: BridgeQuoteRequest = { address: WALLET, originChainId: 42161, destinationChainId: 8453, originAsset: "USDC", destinationAsset: "USDC", amount: "25000000" };
const FEE = 21_211n;

function burn(overrides: Partial<{ amount: bigint; domain: number; recipient: Hex; token: Address; caller: Hex; maxFee: bigint; finality: number; hook: Hex }> = {}): Hex {
  return encodeFunctionData({ abi: CCTP_BURN_ABI, functionName: "depositForBurnWithHook", args: [
    overrides.amount ?? 25_000_000n, overrides.domain ?? 6, overrides.recipient ?? pad(WALLET), overrides.token ?? ARBITRUM_USDC,
    overrides.caller ?? ZERO_WORD, overrides.maxFee ?? FEE, overrides.finality ?? 1000, overrides.hook ?? CCTP_FORWARD_HOOK,
  ] });
}

test("Circle carries only USDC to USDC into Base or Arc, from the five Circle networks", () => {
  assert.deepEqual(cctpRoute(REQUEST), { sourceDomain: 3, destinationDomain: 6, burnToken: ARBITRUM_USDC, outputDecimals: 6, finality: 1000 });
  assert.deepEqual(cctpRoute({ originChainId: 1, destinationChainId: 5042, originAsset: "USDC" }), { sourceDomain: 0, destinationDomain: 26, burnToken: ETHEREUM_USDC, outputDecimals: 18, finality: 1000 });
  assert.deepEqual(cctpRoute({ originChainId: 10, destinationChainId: 8453, originAsset: "USDC", destinationAsset: "USDC" })?.burnToken, OPTIMISM_USDC);
  // Arc's own asset is USDC, so the default asset counts; Arc burns at Standard finality (final in about half a second)
  assert.deepEqual(cctpRoute({ originChainId: 5042, destinationChainId: 8453, destinationAsset: "USDC" }), { sourceDomain: 26, destinationDomain: 6, burnToken: ARC_USDC, outputDecimals: 6, finality: 2000 });
  assert.equal(cctpRoute({ originChainId: 8453, destinationChainId: 5042, originAsset: "USDC" })?.burnToken, BASE_USDC);
  for (const route of [
    { originChainId: 8453, destinationChainId: 5042 }, // Base ETH
    { originChainId: 8453, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "ETH" },
    { originChainId: 42161, destinationChainId: 8453, originAsset: "USDC" }, // Base default asset is ETH
    { originChainId: 8453, destinationChainId: 8453, originAsset: "USDC", destinationAsset: "USDC" },
    { originChainId: 8453, destinationChainId: 4663, originAsset: "USDC", destinationAsset: "USDG" }, // Robinhood has no USDC route
    { originChainId: 4663, destinationChainId: 8453, originAsset: "USDG", destinationAsset: "USDC" },
    { originChainId: 8453, destinationChainId: 1, originAsset: "USDC", destinationAsset: "USDC" }, // funding networks only send
  ] as const) assert.equal(cctpRoute(route), null, JSON.stringify(route));
});

test("a burn's fee is read back only from the exact calldata this bridge builds", () => {
  assert.equal(cctpBurnData(REQUEST, FEE), burn());
  assert.equal(cctpBurnFee(burn(), REQUEST), FEE);
  // exactly 5% is the ceiling; a wei above it is refused
  assert.equal(cctpBurnFee(burn({ maxFee: 1_250_000n }), REQUEST), 1_250_000n);
  assert.equal(cctpBurnFee(burn({ maxFee: 1_250_001n }), REQUEST), null);
  for (const [name, data] of [
    ["recipient", burn({ recipient: pad(OTHER) })],
    ["amount", burn({ amount: 25_000_001n })],
    ["domain", burn({ domain: 26 })],
    ["token", burn({ token: BASE_USDC })],
    ["caller", burn({ caller: pad(OTHER) })],
    ["finality", burn({ finality: 2000 })],
    ["hook", burn({ hook: "0x" })],
    ["hook payload", burn({ hook: `${CCTP_FORWARD_HOOK}00000001` })],
    ["trailing bytes", `${burn()}00` as Hex],
    ["other function", encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [CCTP_TOKEN_MESSENGER, 25_000_000n] })],
  ] as const) assert.equal(cctpBurnFee(data, REQUEST), null, name);
  for (const data of [undefined, 1, "", "0x", "not hex", `0x${"00".repeat(500)}`]) assert.equal(cctpBurnFee(data, REQUEST), null);
  assert.throws(() => cctpBurnData(REQUEST, 0n));
  assert.throws(() => cctpBurnData(REQUEST, 25_000_000n));
  assert.throws(() => cctpBurnData({ ...REQUEST, destinationAsset: "ETH" }, FEE));
});

test("what arrives is the amount less the whole fee, in the destination's own units", () => {
  assert.equal(cctpAmountOut(25_000_000n, FEE, 6), 24_978_789n);
  assert.equal(cctpAmountOut(25_000_000n, FEE, 18), 24_978_789_000_000_000_000n);
});

function burnLog(overrides: Partial<{ address: Address; depositor: Address; finality: number; amount: bigint; maxFee: bigint; hook: Hex; recipient: Hex; domain: number; caller: Hex }> = {}) {
  const topics = encodeEventTopics({ abi: CCTP_BURN_EVENT, eventName: "DepositForBurn", args: { burnToken: ARBITRUM_USDC, depositor: overrides.depositor ?? WALLET, minFinalityThreshold: overrides.finality ?? 1000 } }) as Hex[];
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes" }],
    [overrides.amount ?? 25_000_000n, overrides.recipient ?? pad(WALLET), overrides.domain ?? 6, pad(CCTP_TOKEN_MESSENGER), overrides.caller ?? ZERO_WORD, overrides.maxFee ?? FEE, overrides.hook ?? CCTP_FORWARD_HOOK],
  );
  return { address: overrides.address ?? CCTP_TOKEN_MESSENGER, data, topics, transactionHash: HASH };
}

const TRANSFER: TrackedBridgeTransfer = { ...REQUEST, provider: "cctp", sourceBlock: "1000", requestId: `0x${"12".repeat(32)}`, destinationHashes: [], status: "pending", createdAt: 1, depositData: burn(), depositKind: "erc20" };

test("only Circle's own burn event with every saved field counts as this transfer's burn", () => {
  assert.equal(isCctpBurnLog(burnLog(), TRANSFER), true);
  for (const [name, log] of [
    ["emitter", burnLog({ address: OTHER })],
    ["depositor", burnLog({ depositor: OTHER })],
    ["finality", burnLog({ finality: 2000 })],
    ["amount", burnLog({ amount: 1n })],
    ["fee", burnLog({ maxFee: FEE + 1n })],
    ["hook", burnLog({ hook: "0x" })],
    ["recipient", burnLog({ recipient: pad(OTHER) })],
    ["domain", burnLog({ domain: 26 })],
    ["caller", burnLog({ caller: pad(OTHER) })],
  ] as const) assert.equal(isCctpBurnLog(log, TRANSFER), false, name);
  assert.equal(isCctpBurnLog({ ...burnLog(), topics: burnLog().topics.slice(0, 3) }, TRANSFER), false);
  assert.equal(isCctpBurnLog(burnLog(), { ...TRANSFER, depositData: undefined }), false);
  assert.equal(hasMatchingDepositEvent(TRANSFER, { status: "success", logs: [burnLog({ amount: 1n }), burnLog()] }), true);
  assert.equal(hasMatchingDepositEvent(TRANSFER, { status: "reverted", logs: [burnLog()] }), false);
  assert.equal(isMatchingSourceDeposit(TRANSFER, { from: WALLET, to: CCTP_TOKEN_MESSENGER, input: burn(), value: 0n }), true);
  assert.equal(isMatchingSourceDeposit(TRANSFER, { from: OTHER, to: CCTP_TOKEN_MESSENGER, input: burn(), value: 0n }), false);
  assert.equal(isMatchingSourceDeposit(TRANSFER, { from: WALLET, to: OTHER, input: burn(), value: 0n }), false);
  assert.equal(isMatchingSourceDeposit(TRANSFER, { from: WALLET, to: CCTP_TOKEN_MESSENGER, input: burn(), value: 1n }), false);
});

function circleQuote(overrides: Partial<BridgeQuote> = {}, now = 1_000): BridgeQuote {
  const out = cctpAmountOut(25_000_000n, FEE, 6).toString();
  return {
    ...REQUEST, provider: "cctp", requestId: `0x${"12".repeat(32)}`, amountOut: out, minimumAmountOut: out, relayFee: "0.021211", sourceGas: "0.0000022",
    totalImpactPercent: `-${bridgeFeePercent(FEE, 25_000_000n)}`, approval: { token: ARBITRUM_USDC, spender: CCTP_TOKEN_MESSENGER, amount: REQUEST.amount },
    timeEstimate: 25, expiresAt: now + 45_000, ttlMs: 45_000, transaction: { to: CCTP_TOKEN_MESSENGER, data: burn(), value: "0", chainId: 42161 },
    ...overrides,
  };
}

test("the browser accepts a Circle quote only when it is exactly the burn it would build itself", () => {
  assert.deepEqual(validateBridgeQuote(circleQuote(), REQUEST, 1_000), circleQuote());
  const tx = circleQuote().transaction;
  for (const [name, quote] of [
    ["provider", circleQuote({ provider: "other" as "cctp" })],
    ["spender", circleQuote({ approval: { token: ARBITRUM_USDC, spender: "0x4cd00e387622c35bddb9b4c962c136462338bc31", amount: REQUEST.amount } })],
    ["approval token", circleQuote({ approval: { token: BASE_USDC, spender: CCTP_TOKEN_MESSENGER, amount: REQUEST.amount } })],
    ["approval amount", circleQuote({ approval: { token: ARBITRUM_USDC, spender: CCTP_TOKEN_MESSENGER, amount: "25000001" } })],
    ["no approval", circleQuote({ approval: undefined })],
    ["target", circleQuote({ transaction: { ...tx, to: OTHER } })],
    ["value", circleQuote({ transaction: { ...tx, value: "1" } })],
    ["chain", circleQuote({ transaction: { ...tx, chainId: 8453 } })],
    ["recipient", circleQuote({ transaction: { ...tx, data: burn({ recipient: pad(OTHER) }) } })],
    ["hook", circleQuote({ transaction: { ...tx, data: burn({ hook: "0x" }) } })],
    ["output", circleQuote({ amountOut: "24978790", minimumAmountOut: "24978790" })],
    ["minimum", circleQuote({ minimumAmountOut: "24978788" })],
    ["fee shown", circleQuote({ relayFee: "0.02" })],
  ] as const) assert.throws(() => validateBridgeQuote(quote, REQUEST, 1_000), Error, name);
  // a different fee is fine when every number agrees with it
  const cheaper = burn({ maxFee: 20_000n });
  const out = cctpAmountOut(25_000_000n, 20_000n, 6).toString();
  assert.doesNotThrow(() => validateBridgeQuote(circleQuote({ transaction: { ...tx, data: cheaper }, amountOut: out, minimumAmountOut: out, relayFee: "0.02", totalImpactPercent: "-0.08" }), REQUEST, 1_000));
});

test("a Circle record survives storage only with its burn intact, and old Relay records are unchanged", () => {
  const sent = { ...TRANSFER, sourceHash: HASH };
  const saved = serializeTransfer(sent);
  assert.equal(JSON.parse(saved).version, 4);
  assert.deepEqual(parseStoredTransfer(saved, WALLET), sent);
  const withoutBlock: TrackedBridgeTransfer = { ...sent };
  delete withoutBlock.sourceBlock;
  assert.deepEqual(parseStoredTransfer(serializeTransfer(withoutBlock), WALLET), withoutBlock);
  const tamper = (patch: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(saved), ...patch });
  for (const [name, raw] of [
    ["version", tamper({ version: 3 })],
    ["recipient", tamper({ depositData: burn({ recipient: pad(OTHER) }) })],
    ["amount", tamper({ amount: "26000000" })],
    ["kind", tamper({ depositKind: undefined })],
    ["block", tamper({ sourceBlock: "-1" })],
    ["block type", tamper({ sourceBlock: 1000 })],
    ["provider", tamper({ provider: "relay" })],
  ] as const) assert.throws(() => parseStoredTransfer(raw, WALLET), Error, name);
  // a Relay record never carries Circle's fields
  const relay = { address: WALLET, originChainId: 8453, destinationChainId: 4663, amount: "1", requestId: TRANSFER.requestId, destinationHashes: [], status: "pending", createdAt: 1, version: 1 };
  assert.doesNotThrow(() => parseStoredTransfer(JSON.stringify(relay), WALLET));
  assert.throws(() => parseStoredTransfer(JSON.stringify({ ...relay, sourceBlock: "1" }), WALLET));
});

test("Circle status is asked by the burn's own transaction, and not at all before there is one", () => {
  assert.equal(bridgeStatusUrl({ ...TRANSFER, provider: undefined }), `/api/bridge/status?requestId=${TRANSFER.requestId}`);
  assert.equal(bridgeStatusUrl(TRANSFER), null);
  const url = new URL(bridgeStatusUrl({ ...TRANSFER, sourceHash: HASH })!, "https://openlaunch.lol");
  assert.deepEqual(Object.fromEntries(url.searchParams), { provider: "cctp", origin: "42161", destination: "8453", hash: HASH, address: WALLET, amount: "25000000" });
});

test("a burn the wallet never reported is found by its own event, once, inside the scan window", async () => {
  const calls: { fromBlock: bigint; toBlock: bigint; args: unknown }[] = [];
  const reader = (latest: bigint, logs: ReturnType<typeof burnLog>[]) => ({
    getBlockNumber: async () => latest,
    getLogs: async (args: { fromBlock: bigint; toBlock: bigint; args: unknown }) => { calls.push(args); return logs; },
  });
  assert.equal(await findCctpBurn(reader(1_050n, [burnLog({ amount: 1n }), burnLog()]), TRANSFER), HASH);
  assert.deepEqual(calls.at(-1), { address: CCTP_TOKEN_MESSENGER, event: CCTP_BURN_EVENT[0], args: { burnToken: ARBITRUM_USDC, depositor: WALLET }, fromBlock: 1_000n, toBlock: 1_050n });
  await findCctpBurn(reader(1_000_000n, []), TRANSFER);
  assert.equal(calls.at(-1)!.toBlock, 1_000n + CCTP_SCAN_BLOCKS);
  // the same burn in two logs is one burn; two different burns are ambiguous
  assert.equal(await findCctpBurn(reader(1_050n, [burnLog(), burnLog()]), TRANSFER), HASH);
  assert.equal(await findCctpBurn(reader(1_050n, [burnLog(), { ...burnLog(), transactionHash: `0x${"cd".repeat(32)}` as Hex }]), TRANSFER), null);
  assert.equal(await findCctpBurn(reader(1_050n, [burnLog({ depositor: OTHER })]), TRANSFER), null);
  const before = calls.length;
  assert.equal(await findCctpBurn(reader(999n, [burnLog()]), TRANSFER), null);
  assert.equal(await findCctpBurn(reader(1_050n, [burnLog()]), { ...TRANSFER, sourceBlock: undefined }), null);
  assert.equal(await findCctpBurn(reader(1_050n, [burnLog()]), { ...TRANSFER, provider: undefined }), null);
  assert.equal(calls.length, before);
});

test("a Circle deposit records its provider and the block to look from, and still sends if that block is unknown", async () => {
  const quote = circleQuote({}, Date.now());
  const saved: TrackedBridgeTransfer[] = [];
  const deps = (sourceBlock: DepositDependencies["sourceBlock"]): DepositDependencies => ({
    now: () => quote.expiresAt - 45_000, currentRequest: () => REQUEST, readWallet: async () => ({ address: WALLET, chainId: 42161 }),
    switchChain: async () => {}, prepare: async () => ({ gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }), readTransfer: () => null,
    saveTransfer: (transfer) => { saved.push(transfer); }, removeTransfer: () => {}, sourceBlock, send: async () => HASH, phase: () => {},
  });
  const sent = await submitBridgeDeposit(quote, deps(async () => 77n));
  assert.equal(sent.kind, "sent");
  assert.equal(saved[0].provider, "cctp");
  assert.equal(saved[0].sourceBlock, "77");
  saved.length = 0;
  const unknown = await submitBridgeDeposit(quote, deps(async () => { throw new Error("rpc down"); }));
  assert.equal(unknown.kind, "sent");
  assert.equal(saved[0].provider, "cctp");
  assert.equal(saved[0].sourceBlock, undefined);
});
