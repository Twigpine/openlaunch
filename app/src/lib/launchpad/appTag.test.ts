import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { ACCOUNT_CALL_ABI, HANDLE_OPS_ABI, accountCalls, appTagOf, endsWithSuffix, swapInApp } from "./appTag.ts";
import { BUILDER_DATA_SUFFIX } from "../chainPublic.ts";

const ROUTER = "0x6ff5693b99212da76ad316178a184ab56d299b43";
const EP06 = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789";
const EP07 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const SUFFIX = BUILDER_DATA_SUFFIX;
const tail = SUFFIX.slice(2);
const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000bb";
const execute = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const swapCall = encodeFunctionData({ abi: execute, args: ["0x10", ["0x1234"], 1n] });
const smartExecute = parseAbi(["function execute(address target, uint256 value, bytes data)"]);
/** A smart wallet's operation calling the router with `data`. */
const opCall = (data: Hex) => encodeFunctionData({ abi: smartExecute, args: [ROUTER, 0n, data] });
const op06 = (sender: string, callData: Hex) => ({ sender: sender as Hex, nonce: 0n, initCode: "0x" as Hex, callData, callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, paymasterAndData: "0x" as Hex, signature: "0x" as Hex });
const op07 = (sender: string, callData: Hex) => ({ sender: sender as Hex, nonce: 0n, initCode: "0x" as Hex, callData, accountGasLimits: `0x${"0".repeat(64)}` as Hex, preVerificationGas: 1n, gasFees: `0x${"0".repeat(64)}` as Hex, paymasterAndData: "0x" as Hex, signature: "0x" as Hex });
const bundle06 = (ops: ReturnType<typeof op06>[]) => encodeFunctionData({ abi: [HANDLE_OPS_ABI[0]], args: [ops, OTHER as Hex] });
const bundle07 = (ops: ReturnType<typeof op07>[]) => encodeFunctionData({ abi: [HANDLE_OPS_ABI[1]], args: [ops, OTHER as Hex] });

// another wallet's own ERC-8021 suffix ("bc_other", schema 0), as it would append after ours
const OTHER_CODE = "62635f6f74686572" + "08" + "00" + "80218021802180218021802180218021";

test("a wallet's own router call is in-app with the suffix at the end (or followed only by another builder suffix)", () => {
  assert.equal(appTagOf({ to: ROUTER, input: swapCall + tail, router: ROUTER, suffix: SUFFIX }).direct, true);
  assert.equal(appTagOf({ to: ROUTER, input: swapCall + tail + OTHER_CODE, router: ROUTER, suffix: SUFFIX }).direct, true);
  // anything else after it, or the same bytes inside the swap's arguments, is not our suffix
  assert.equal(appTagOf({ to: ROUTER, input: swapCall + tail + "deadbeef", router: ROUTER, suffix: SUFFIX }).direct, false);
  const embedded = encodeFunctionData({ abi: execute, args: ["0x10", [`0x${tail}`], 1n] });
  assert.equal(appTagOf({ to: ROUTER, input: embedded, router: ROUTER, suffix: SUFFIX }).direct, false);
  assert.equal(endsWithSuffix("ab" + "00".repeat(300) + "80218021802180218021802180218021", "ab"), false, "a tail longer than any suffix");
  assert.equal(appTagOf({ to: ROUTER, input: swapCall, router: ROUTER, suffix: SUFFIX }).direct, false);
  // the suffix on a call to anything but the router (a bot contract, an aggregator) is not in-app
  assert.equal(appTagOf({ to: OTHER, input: swapCall + tail, router: ROUTER, suffix: SUFFIX }).direct, false);
  assert.equal(appTagOf({ to: null, input: swapCall + tail, router: ROUTER, suffix: SUFFIX }).direct, false);
});

test("a smart wallet's operation is in-app only for the account whose own callData carries the suffix (v0.6 and v0.7)", () => {
  const tagged = opCall((swapCall + tail) as Hex);
  const plain = opCall(swapCall);
  for (const [ep, input] of [
    [EP06, bundle06([op06(OTHER, plain), op06(ACCOUNT, tagged)])],
    [EP07, bundle07([op07(OTHER, plain), op07(ACCOUNT, tagged)])],
  ] as const) {
    const tag = appTagOf({ to: ep, input, router: ROUTER, suffix: SUFFIX });
    assert.deepEqual(tag, { direct: false, senders: [ACCOUNT] }, ep);
    assert.equal(swapInApp(tag, ACCOUNT, "userop"), true);
    assert.equal(swapInApp(tag, OTHER, "userop"), false, "another account in the same bundle");
    assert.equal(swapInApp(tag, "0x00000000000000000000000000000000000000cc", "tx_from"), false, "credited to the bundler");
  }
  assert.deepEqual(appTagOf({ to: EP06, input: bundle06([op06(ACCOUNT, plain)]), router: ROUTER, suffix: SUFFIX }), { direct: false, senders: [] });
  // the suffix on an operation that calls something other than the router (a bot contract, an aggregator) is not in-app
  const elsewhere = encodeFunctionData({ abi: smartExecute, args: [OTHER as Hex, 0n, (swapCall + tail) as Hex] });
  assert.deepEqual(appTagOf({ to: EP06, input: bundle06([op06(ACCOUNT, elsewhere)]), router: ROUTER, suffix: SUFFIX }), { direct: false, senders: [] });
  // nor one that only names the router inside its arguments, or a router call with the suffix buried in its arguments
  const namesRouter = encodeFunctionData({ abi: smartExecute, args: [OTHER as Hex, 0n, (encodeFunctionData({ abi: parseAbi(["function go(address r, bytes d)"]), args: [ROUTER, swapCall] }) + tail) as Hex] });
  assert.deepEqual(appTagOf({ to: EP06, input: bundle06([op06(ACCOUNT, namesRouter)]), router: ROUTER, suffix: SUFFIX }), { direct: false, senders: [] });
  const buried = opCall(encodeFunctionData({ abi: execute, args: ["0x10", [`0x${tail}`], 1n] }));
  assert.deepEqual(appTagOf({ to: EP06, input: bundle06([op06(ACCOUNT, buried)]), router: ROUTER, suffix: SUFFIX }), { direct: false, senders: [] });
  assert.deepEqual(appTagOf({ to: EP06, input: "0xdeadbeef" + tail, router: ROUTER, suffix: SUFFIX }), { direct: false, senders: [] }, "not a bundle");
});

test("an unread transaction is unknown, never in-app", () => {
  assert.equal(swapInApp(null, ACCOUNT, "tx_from"), null);
  assert.equal(swapInApp({ direct: true, senders: [] }, null, null), null);
  assert.equal(swapInApp({ direct: true, senders: [] }, ACCOUNT, "tx_from"), true);
});

test("smart-account call formats: Coinbase Smart Wallet execute and executeBatch, SimpleAccount batches; others are not read", () => {
  const callData = (swapCall + tail) as Hex;
  const formats = [
    encodeFunctionData({ abi: [ACCOUNT_CALL_ABI[0]], args: [ROUTER, 0n, callData] }),
    encodeFunctionData({ abi: [ACCOUNT_CALL_ABI[1]], args: [[{ target: OTHER as Hex, value: 0n, data: "0x" }, { target: ROUTER, value: 0n, data: callData }]] }),
    encodeFunctionData({ abi: [ACCOUNT_CALL_ABI[2]], args: [[OTHER as Hex, ROUTER], ["0x", callData]] }),
    encodeFunctionData({ abi: [ACCOUNT_CALL_ABI[3]], args: [[ROUTER], [0n], [callData]] }),
  ];
  for (const cd of formats) assert.deepEqual(appTagOf({ to: EP07, input: bundle07([op07(ACCOUNT, cd as Hex)]), router: ROUTER, suffix: SUFFIX }).senders, [ACCOUNT], cd.slice(0, 10));
  assert.deepEqual(accountCalls("0xdeadbeef"), []);
});
