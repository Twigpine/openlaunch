import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, type TransactionReceipt } from "viem";
import { ERC20_TRANSFER_EVENT } from "./abi";
import { BOOST_TOKEN, BOOST_DEAD, boostAmount, TAG_SPACE } from "./boost";
import { boostReceiptAmount } from "./boost-receipt";

const hash = `0x${"ab".repeat(32)}` as const;
const sender = `0x${"11".repeat(20)}` as const;
const locker = `0x${"22".repeat(20)}` as const;
const tag = 123n;
function burn(value = boostAmount(300_000n, tag), from = sender, to = BOOST_DEAD) {
  return { address: BOOST_TOKEN, transactionHash: hash, blockNumber: 1n, logIndex: 0, removed: false,
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    topics: encodeEventTopics({ abi: [ERC20_TRANSFER_EVENT], eventName: "Transfer", args: { from, to: to as `0x${string}` } }),
  } as TransactionReceipt["logs"][number];
}
function receipt(logs = [burn()]) { return { transactionHash: hash, logs }; }

test("replacement boost amount follows actual Transfer facts, including fractional amounts and multiple qualifying burns", () => {
  const actual = boostAmount(300_000n, tag) + TAG_SPACE;
  assert.equal(boostReceiptAmount(receipt([burn(actual)]), tag, locker), actual);
  assert.equal(boostReceiptAmount(receipt([burn(), { ...burn(), logIndex: 1 }]), tag, locker), 2n * boostAmount(300_000n, tag));
});

test("cancellation, wrong token, recipient, launch tag, floor, and locker burns never become this token's boost", () => {
  for (const logs of [[], [{ ...burn(), address: sender }], [burn(undefined, sender, sender)], [burn(boostAmount(300_000n, tag + 1n))], [burn(boostAmount(99_999n, tag))], [burn(undefined, locker as typeof sender)]]) {
    assert.equal(boostReceiptAmount(receipt(logs), tag, locker), null);
  }
});

test("malformed, removed, duplicate, or mismatched receipt logs cannot resolve a replacement", () => {
  for (const logs of [[{ ...burn(), transactionHash: `0x${"cd".repeat(32)}` as const }], [{ ...burn(), removed: true }], [burn(), burn()], [{ ...burn(), data: "0x" as const }], [{ ...burn(), logIndex: null }]]) {
    assert.throws(() => boostReceiptAmount(receipt(logs), tag, locker));
  }
});
