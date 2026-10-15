import assert from "node:assert/strict";
import test from "node:test";
import { isBusy, revertedCopy, type EarnPhase } from "./phase.ts";

test("a send whose outcome is unknown keeps the form busy; only final states free it", () => {
  const busy: EarnPhase[] = [
    { k: "preparing" }, { k: "approving" }, { k: "signing" }, { k: "sent", hash: null },
    { k: "unconfirmed", tab: "deposit", amount: 1n, sent: { kind: "tx", hash: "0x01" }, checking: false, note: null },
  ];
  for (const p of busy) assert.equal(isBusy(p), true, p.k);
  for (const p of [{ k: "idle" }, { k: "error", message: "x" }, { k: "done", hash: null, tab: "deposit", amount: 1n }] as EarnPhase[]) assert.equal(isBusy(p), false, p.k);
});

test("a reverted receipt says nothing moved", () => {
  assert.equal(revertedCopy("deposit"), "The deposit reverted on-chain. Nothing moved; network gas was still charged.");
  assert.match(revertedCopy("withdraw"), /^The withdrawal reverted/);
});
