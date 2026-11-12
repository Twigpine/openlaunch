import assert from "node:assert/strict";
import test from "node:test";
import type { PublicClient } from "viem";
import { waitForTrackedReceipt } from "./transaction-receipt";

const hash = `0x${"ab".repeat(32)}` as const;
const replacement = `0x${"cd".repeat(32)}` as const;
const sender = `0x${"12".repeat(20)}` as const;
const original = { hash, from: sender, nonce: 7, to: sender, input: "0xab", value: 0n };
const next = { ...original, hash: replacement };
function reader(event?: object, receiptHash = event ? replacement : hash) {
  return { waitForTransactionReceipt: async ({ onReplaced }: { onReplaced: (event: object) => void }) => {
    if (event) onReplaced(event);
    return { transactionHash: receiptHash, status: "success", logs: [] };
  } } as unknown as Pick<PublicClient, "waitForTransactionReceipt">;
}
const event = { reason: "repriced", replacedTransaction: original, transaction: next, transactionReceipt: { transactionHash: replacement } };

test("receipt tracking adopts an exact repricing and reports changed calls separately", async () => {
  const adopted: string[] = [];
  assert.equal((await waitForTrackedReceipt(reader(), hash, () => assert.fail())).changed, false);
  const repriced = await waitForTrackedReceipt(reader(event), hash, (h) => adopted.push(h));
  assert.equal(repriced.receipt.transactionHash, replacement);
  assert.deepEqual(adopted, [replacement]);
  assert.equal(repriced.changed, false);
  for (const reason of ["cancelled", "replaced"]) {
    const changed = await waitForTrackedReceipt(reader({ ...event, reason, transaction: { ...next, input: "0x" } }), hash, () => assert.fail("changed call is not an adopted repricing"));
    assert.equal(changed.changed, true);
  }
});

test("hash, sender, nonce and calldata mismatches never become a successful repricing", async () => {
  for (const bad of [
    { ...event, replacedTransaction: { ...original, hash: replacement } },
    { ...event, transaction: { ...next, from: `0x${"34".repeat(20)}` } },
    { ...event, transaction: { ...next, nonce: 8 } },
    { ...event, transaction: { ...next, input: "0xffff" } },
    { ...event, transactionReceipt: { transactionHash: hash } },
  ]) await assert.rejects(waitForTrackedReceipt(reader(bad), hash, () => assert.fail()), /could not be matched/);
  await assert.rejects(waitForTrackedReceipt(reader(undefined, replacement), hash, () => assert.fail()), /could not be matched/);
});

test("a timeout after a verified repricing has already retained the replacement reference", async () => {
  const retained: string[] = [];
  const pub = { waitForTransactionReceipt: async ({ onReplaced }: { onReplaced: (event: object) => void }) => { onReplaced(event); throw Error("timeout"); } } as unknown as Pick<PublicClient, "waitForTransactionReceipt">;
  await assert.rejects(waitForTrackedReceipt(pub, hash, (h) => retained.push(h)), /timeout/);
  assert.deepEqual(retained, [replacement]);
});
