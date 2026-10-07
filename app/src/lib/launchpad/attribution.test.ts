import { test } from "node:test";
import assert from "node:assert/strict";
import { USER_OPERATION_EVENT, attributeSwap, isDelegationCode, needsCode, userOpSender, type ReceiptLog } from "./attribution.ts";

const EP7 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const UR = "0x00000000000000000000000000000000000000bb";
const PM = "0x00000000000000000000000000000000000000aa";
const USER = "0x1111111111111111111111111111111111111111";
const BUNDLER = "0x2222222222222222222222222222222222222222";
const SMART_A = "0x3333333333333333333333333333333333333333";
const SMART_B = "0x4444444444444444444444444444444444444444";
const VICTIM = "0x5555555555555555555555555555555555555555";
const system = [UR, PM];
const word = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
const uoe = (logIndex: number, sender: string, ep = EP7): ReceiptLog => ({ address: ep, logIndex, topics: [USER_OPERATION_EVENT, `0x${"ab".repeat(32)}`, word(sender), word("0x0000000000000000000000000000000000000000")] });

test("the event selector is the ERC-4337 UserOperationEvent", () => {
  assert.equal(USER_OPERATION_EVENT, "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f");
});

test("an EOA swap through the router keeps the sender", () => {
  assert.deepEqual(attributeSwap({ from: USER, to: UR, swapLogIndex: 4, system }), { trader: USER, via: "tx_from" });
});

test("buying for someone else's wallet never puts the trade under their name", () => {
  // the attacker routes the output to a victim: the only evidence is a token transfer, which is not evidence
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: UR, swapLogIndex: 4, toCode: "0x6080", system }), { trader: BUNDLER, via: "tx_from" });
});

test("a 4337 swap is credited to the sender of the operation that contains it", () => {
  const logs = [uoe(9, SMART_A)];
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 5, logs, system }), { trader: SMART_A, via: "userop" });
});

test("in a bundle of two operations each swap goes to its own operation's sender", () => {
  const logs = [uoe(6, SMART_A), uoe(14, SMART_B)];
  assert.equal(userOpSender(logs, EP7, 3), SMART_A);
  assert.equal(userOpSender(logs, EP7, 10), SMART_B);
  assert.equal(userOpSender(logs, EP7, 20), null, "no operation closes after it: no proof");
});

test("a UserOperationEvent from another contract is ignored", () => {
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 5, logs: [uoe(9, VICTIM, "0x9999999999999999999999999999999999999999")], system }), { trader: BUNDLER, via: "tx_from" });
});

test("an EntryPoint transaction whose receipt could not be read keeps the sender", () => {
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 5, logs: null, system }), { trader: BUNDLER, via: "tx_from" });
});

test("a relayed 7702 call is credited to the delegating account", () => {
  const code = `0xef0100${"c".repeat(40)}`;
  assert.ok(isDelegationCode(code));
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: SMART_A, swapLogIndex: 5, toCode: code, system }), { trader: SMART_A, via: "7702" });
  assert.ok(!isDelegationCode("0x6080604052"));
  assert.ok(!isDelegationCode("0x"));
});

test("code is only read for plain targets, never for the router, the EntryPoint or a self-call", () => {
  assert.equal(needsCode(USER, UR, system), false);
  assert.equal(needsCode(BUNDLER, EP7, system), false);
  assert.equal(needsCode(USER, USER, system), false);
  assert.equal(needsCode(USER, null, system), false);
  assert.equal(needsCode(BUNDLER, SMART_A, system), true);
});
