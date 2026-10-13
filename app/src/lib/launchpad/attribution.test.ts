import { test } from "node:test";
import assert from "node:assert/strict";
import { BEFORE_EXECUTION_EVENT, ERC20_TRANSFER_EVENT, USER_OPERATION_EVENT, attributeSwap, userOpSender, userOpWindow, type ReceiptLog } from "./attribution.ts";

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

// ── operations with a paymaster: its postOp runs inside the same window ──
const PAYMASTER = "0x6666666666666666666666666666666666666666";
const POOL_MANAGER = "0x7777777777777777777777777777777777777777";
const TOKEN = "0x8888888888888888888888888888888888888888";
const OTHER_TOKEN = "0x9999999999999999999999999999999999999999";
const sponsored = (logIndex: number, sender: string, paymaster = PAYMASTER): ReceiptLog => ({ address: EP7, logIndex, topics: [USER_OPERATION_EVENT, `0x${"cd".repeat(32)}`, word(sender), word(paymaster)] });
const transfer = (logIndex: number, token: string, from: string, to: string): ReceiptLog => ({ address: token, logIndex, topics: [ERC20_TRANSFER_EVENT, word(from), word(to)] });

test("ERC-20 Transfer selector", () => {
  assert.equal(ERC20_TRANSFER_EVENT, "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
});

test("paymaster op: a buy whose tokens reached the account inside its operation is the account's", () => {
  const logs = [before(1), transfer(4, TOKEN, POOL_MANAGER, SMART_A), sponsored(9, SMART_A)];
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 3, logs, token: TOKEN }), { trader: SMART_A, via: "userop" });
});

test("paymaster op: a sell whose tokens left the account inside its operation is the account's", () => {
  const logs = [before(1), transfer(2, TOKEN, SMART_A, POOL_MANAGER), sponsored(9, SMART_A)];
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 3, logs, token: TOKEN }), { trader: SMART_A, via: "userop" });
});

test("paymaster op: a swap the account's tokens never took part in (a postOp swap) stays on the sender", () => {
  const logs = [before(1), transfer(4, TOKEN, POOL_MANAGER, PAYMASTER), sponsored(9, SMART_A)];
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 3, logs, token: TOKEN }), { trader: BUNDLER, via: "tx_from" });
});

test("paymaster op: the account moving a different token is not evidence for this one", () => {
  const logs = [before(1), transfer(4, OTHER_TOKEN, POOL_MANAGER, SMART_A), sponsored(9, SMART_A)];
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 3, logs, token: TOKEN }), { trader: BUNDLER, via: "tx_from" });
});

test("paymaster op: the account's transfer in another operation of the bundle does not count", () => {
  // op 1 (SMART_A, unsponsored) moves TOKEN to SMART_B; op 2 (SMART_B, sponsored) holds the swap but SMART_B moved nothing in it
  const logs = [before(1), transfer(3, TOKEN, POOL_MANAGER, SMART_B), uoe(5, SMART_A), sponsored(12, SMART_B)];
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 8, logs, token: TOKEN }), { trader: BUNDLER, via: "tx_from" });
  assert.deepEqual(userOpWindow(logs, EP7, 8), { sender: SMART_B, paymaster: PAYMASTER, start: 5, close: 12 });
});

test("paymaster op without the token known: stays on the sender (never guessed)", () => {
  const logs = [before(1), transfer(4, TOKEN, POOL_MANAGER, SMART_A), sponsored(9, SMART_A)];
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 3, logs }), { trader: BUNDLER, via: "tx_from" });
});

test("no paymaster: the window is the account's execution alone, no token evidence needed", () => {
  const logs = [before(1), uoe(9, SMART_A)];
  assert.deepEqual(userOpWindow(logs, EP7, 3), { sender: SMART_A, paymaster: null, start: 1, close: 9 });
  assert.deepEqual(attributeSwap({ from: BUNDLER, to: EP7, swapLogIndex: 3, logs, token: TOKEN }), { trader: SMART_A, via: "userop" });
});
