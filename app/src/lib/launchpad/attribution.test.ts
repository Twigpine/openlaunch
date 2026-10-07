import { test } from "node:test";
import assert from "node:assert/strict";
import { BEFORE_EXECUTION_EVENT, USER_OPERATION_EVENT, attributeSwap, userOpSender, type ReceiptLog } from "./attribution.ts";

const EP7 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const UR = "0x00000000000000000000000000000000000000bb";
const USER = "0x1111111111111111111111111111111111111111";
const BUNDLER = "0x2222222222222222222222222222222222222222";
const SMART_A = "0x3333333333333333333333333333333333333333";
const SMART_B = "0x4444444444444444444444444444444444444444";
const VICTIM = "0x5555555555555555555555555555555555555555";
const word = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
const uoe = (logIndex: number, sender: string, ep = EP7): ReceiptLog => ({ address: ep, logIndex, topics: [USER_OPERATION_EVENT, `0x${"ab".repeat(32)}`, word(sender), word("0x0000000000000000000000000000000000000000")] });
const before = (logIndex: number, ep = EP7): ReceiptLog => ({ address: ep, logIndex, topics: [BEFORE_EXECUTION_EVENT] });

test("event selectors are the ERC-4337 ones", () => {
  assert.equal(USER_OPERATION_EVENT, "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f");
  assert.equal(BEFORE_EXECUTION_EVENT, "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972");
});

test("an EOA swap through the router keeps the sender", () => {
  assert.deepEqual(attributeSwap({ from: USER, to: UR, swapLogIndex: 4 }), { trader: USER, via: "tx_from" });
});

test("buying for someone else's wallet never puts the trade under their name", () => {
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: UR, swapLogIndex: 4 }), { trader: BUNDLER, via: "tx_from" });
});

test("a 4337 swap is credited to the sender of the operation whose execution contains it", () => {
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 5, logs: [before(2), uoe(9, SMART_A)] }), { trader: SMART_A, via: "userop" });
});

test("in a bundle of two operations each swap goes to its own operation's sender", () => {
  const logs = [before(1), uoe(6, SMART_A), uoe(14, SMART_B)];
  assert.equal(userOpSender(logs, EP7, 3), SMART_A);
  assert.equal(userOpSender(logs, EP7, 10), SMART_B);
  assert.equal(userOpSender(logs, EP7, 20), null, "no operation closes after it: no proof");
});

test("a swap during validation (before BeforeExecution) belongs to nobody's authorized call", () => {
  // an attacker bundles [victimOp, attackerOp] and swaps inside attackerOp's validation or paymaster check
  const logs = [before(8), uoe(12, VICTIM), uoe(15, BUNDLER)];
  assert.equal(userOpSender(logs, EP7, 3), null);
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 3, logs }), { trader: BUNDLER, via: "tx_from" });
  assert.equal(userOpSender([uoe(9, VICTIM)], EP7, 5), null, "no BeforeExecution at all: no proof");
});

test("events from another contract are ignored", () => {
  const other = "0x9999999999999999999999999999999999999999";
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 5, logs: [before(2, other), uoe(9, VICTIM, other)] }), { trader: BUNDLER, via: "tx_from" });
});

test("an EntryPoint transaction whose receipt could not be read keeps the sender", () => {
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 5, logs: null }), { trader: BUNDLER, via: "tx_from" });
});
