import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeSwap } from "./attribution.ts";

const PM = "0x00000000000000000000000000000000000000aa";
const UR = "0x00000000000000000000000000000000000000bb";
const PERMIT2 = "0x00000000000000000000000000000000000000cc";
const USER = "0x1111111111111111111111111111111111111111";
const BUNDLER = "0x2222222222222222222222222222222222222222";
const SMART = "0x3333333333333333333333333333333333333333";
const BOT = "0x4444444444444444444444444444444444444444";
const system = [PM, UR, PERMIT2];

test("an EOA buy keeps the sender", () => {
  assert.equal(attributeSwap({ legs: [{ log_index: 5, from_addr: PM, to_addr: USER }], txFrom: USER, isBuy: true, swapLogIndex: 4, poolManager: PM, system }), null);
});

test("an EOA sell keeps the sender", () => {
  assert.equal(attributeSwap({ legs: [{ log_index: 6, from_addr: USER, to_addr: PM }], txFrom: USER, isBuy: false, swapLogIndex: 4, poolManager: PM, system }), null);
});

test("a 4337 buy credits the smart wallet, not the bundler", () => {
  assert.equal(attributeSwap({ legs: [{ log_index: 9, from_addr: PM, to_addr: SMART }], txFrom: BUNDLER, isBuy: true, swapLogIndex: 8, poolManager: PM, system }), SMART);
});

test("a 4337 sell credits the smart wallet", () => {
  assert.equal(attributeSwap({ legs: [{ log_index: 11, from_addr: SMART, to_addr: PM }], txFrom: BUNDLER, isBuy: false, swapLogIndex: 10, poolManager: PM, system }), SMART);
});

test("a buy routed through a contract that forwards to the user credits the user", () => {
  const legs = [
    { log_index: 3, from_addr: PM, to_addr: BOT },
    { log_index: 4, from_addr: BOT, to_addr: SMART },
  ];
  assert.equal(attributeSwap({ legs, txFrom: BUNDLER, isBuy: true, swapLogIndex: 2, poolManager: PM, system }), SMART);
});

test("a sell pulled through Permit2 and the router walks back to the owner", () => {
  const legs = [
    { log_index: 7, from_addr: SMART, to_addr: UR },
    { log_index: 8, from_addr: UR, to_addr: PM },
  ];
  assert.equal(attributeSwap({ legs, txFrom: BUNDLER, isBuy: false, swapLogIndex: 6, poolManager: PM, system }), SMART);
});

test("dust left on the router never becomes the trader", () => {
  assert.equal(attributeSwap({ legs: [{ log_index: 3, from_addr: PM, to_addr: UR }], txFrom: BUNDLER, isBuy: true, swapLogIndex: 2, poolManager: PM, system }), null);
});

test("no legs (transfers not indexed) keeps the sender", () => {
  assert.equal(attributeSwap({ legs: [], txFrom: BUNDLER, isBuy: true, swapLogIndex: 2, poolManager: PM, system }), null);
});

test("two swaps in one transaction each take the transfer nearest to their own swap", () => {
  const legs = [
    { log_index: 3, from_addr: PM, to_addr: SMART },
    { log_index: 9, from_addr: PM, to_addr: BOT },
  ];
  assert.equal(attributeSwap({ legs, txFrom: BUNDLER, isBuy: true, swapLogIndex: 2, poolManager: PM, system }), SMART);
  assert.equal(attributeSwap({ legs, txFrom: BUNDLER, isBuy: true, swapLogIndex: 8, poolManager: PM, system }), BOT);
});

test("addresses are compared case-insensitively", () => {
  assert.equal(attributeSwap({ legs: [{ log_index: 5, from_addr: PM.toUpperCase().replace("0X", "0x"), to_addr: USER }], txFrom: USER.toUpperCase().replace("0X", "0x"), isBuy: true, swapLogIndex: 4, poolManager: PM, system }), null);
});
