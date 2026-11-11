import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { HANDLE_OPS_ABI, appTagOf, swapInApp } from "./appTag.ts";
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

test("a wallet's own router call is in-app with the suffix (also when its wallet appends a code after ours)", () => {
  assert.equal(appTagOf({ to: ROUTER, input: swapCall + tail, router: ROUTER, suffix: SUFFIX }).direct, true);
  assert.equal(appTagOf({ to: ROUTER, input: swapCall + tail + "deadbeef", router: ROUTER, suffix: SUFFIX }).direct, true);
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
  assert.deepEqual(appTagOf({ to: EP06, input: "0xdeadbeef" + tail, router: ROUTER, suffix: SUFFIX }), { direct: false, senders: [] }, "not a bundle");
});

test("an unread transaction is unknown, never in-app", () => {
  assert.equal(swapInApp(null, ACCOUNT, "tx_from"), null);
  assert.equal(swapInApp({ direct: true, senders: [] }, null, null), null);
  assert.equal(swapInApp({ direct: true, senders: [] }, ACCOUNT, "tx_from"), true);
});
