import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { PublicClient } from "viem";
import { archivePendingLaunch, captureLaunchIdentity, launchNonceFinalized, pendingLaunch, pendingLaunchServer, recentLaunches, rememberFirstBuy, rememberPendingLaunch, subscribePendingLaunch, type PendingLaunch } from "./pending-launch.ts";

test("sent launch journal restores and validates an existing hash without a wallet action", (t) => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  t.after(() => { rememberPendingLaunch(null); Reflect.deleteProperty(globalThis, "sessionStorage"); });
  assert.equal(pendingLaunchServer(), null);
  let notifications = 0;
  const stop = subscribePendingLaunch(() => notifications++);
  const attempt = { chain: "base", hash: `0x${"ab".repeat(32)}`, token: `0x${"12".repeat(20)}` } as const;
  rememberPendingLaunch(attempt);
  assert.equal(pendingLaunch(), attempt, "snapshot remains stable across renders");
  assert.equal(notifications, 1);
  stop();
  rememberPendingLaunch(null);
  storage.set("ol:pending-launch", JSON.stringify(attempt));
  assert.deepEqual(pendingLaunch(), attempt, "restores the same transaction after reading storage");
  storage.set("ol:pending-launch", JSON.stringify({ ...attempt, chain: "unsupported" }));
  assert.equal(pendingLaunch(), null);
  storage.set("ol:pending-launch", JSON.stringify({ ...attempt, hash: "bad" }));
  assert.equal(pendingLaunch(), null);
});

test("a denied storage write still retains the in-memory send guard", (t) => {
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => null, setItem: () => { throw Error("quota"); }, removeItem: () => {} } });
  t.after(() => { rememberPendingLaunch(null); Reflect.deleteProperty(globalThis, "sessionStorage"); });
  const attempt = { chain: "arc", hash: `0x${"cd".repeat(32)}`, token: null } as const;
  rememberPendingLaunch(attempt);
  assert.equal(pendingLaunch(), attempt);
  assert.equal(pendingLaunch(), attempt);
});

const hash = `0x${"ab".repeat(32)}` as const;
const wallet = `0x${"12".repeat(20)}` as const;
function storageFor(t: TestContext) {
  const storage = new Map([["ol:pending-launch", " "]]);
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) } });
  storage.set("ol:pending-launch", "null ");
  pendingLaunch();
  t.after(() => { storage.set("ol:pending-launch", "null  "); pendingLaunch(); rememberPendingLaunch(null); Reflect.deleteProperty(globalThis, "sessionStorage"); });
  return storage;
}
test("confirmed first buys and indexed references survive a storage reload without blocking an unrelated launch", (t) => {
  const storage = storageFor(t);
  const attempt: PendingLaunch = { chain: "base", hash, token: wallet };
  rememberPendingLaunch(attempt);
  const buy = { hash: `0x${"cd".repeat(32)}` as const, status: "confirmed" as const, amount: "1500000000000000000", exact: true, symbol: "TEST" };
  rememberFirstBuy(hash, buy);
  storage.set("ol:pending-launch", storage.get("ol:pending-launch")! + " ");
  assert.deepEqual(pendingLaunch()?.firstBuy, buy);
  assert.equal(archivePendingLaunch(hash, "indexed", wallet), true);
  assert.equal(pendingLaunch(), null);
  storage.set("ol:pending-launch", storage.get("ol:pending-launch")! + " ");
  assert.deepEqual(recentLaunches()[0], { ...attempt, firstBuy: buy, outcome: "indexed" });
  rememberPendingLaunch({ ...attempt, hash: buy.hash });
  assert.equal(pendingLaunch()?.hash, buy.hash);
  assert.equal(recentLaunches()[0].hash, hash);
  assert.equal(archivePendingLaunch(hash, "indexed"), false, "stale result cannot release a different active attempt");
});

test("references are bounded and old journals never receive fabricated nonce evidence", (t) => {
  const storage = storageFor(t);
  storage.set("ol:pending-launch", JSON.stringify({ chain: "base", hash, token: null }));
  assert.equal(pendingLaunch()?.identity, undefined);
  for (let i = 0; i < 12; i++) {
    const next = `0x${i.toString(16).padStart(64, "0")}` as const;
    rememberPendingLaunch({ chain: "base", hash: next, token: null });
    archivePendingLaunch(next, "indexed");
  }
  assert.equal(recentLaunches().length, 10);
  assert.equal(pendingLaunch(), null);
});

test("only the exact wallet, chain and finalized nonce can authorize an explicit archive", async () => {
  const attempt: PendingLaunch = { chain: "base", hash, token: null, identity: { hash, chainId: 8453, sender: wallet, nonce: 7 } };
  const calls: unknown[] = [];
  const pub = { getChainId: async () => 8453, getTransactionCount: async (args: { blockTag: string }) => { calls.push(args); return args.blockTag === "finalized" ? 8 : 100; } } as unknown as Pick<PublicClient, "getChainId" | "getTransactionCount">;
  assert.equal(await launchNonceFinalized(pub, attempt, wallet), true);
  assert.deepEqual(calls, [{ address: wallet, blockTag: "finalized" }]);
  for (const changed of [
    { ...attempt, identity: undefined },
    { ...attempt, hash: `0x${"cd".repeat(32)}` as const },
    { ...attempt, chain: "arc" as const },
  ]) assert.equal(await launchNonceFinalized(pub, changed, wallet), false);
  assert.equal(await launchNonceFinalized(pub, attempt, `0x${"34".repeat(20)}`), false);
  assert.equal(await launchNonceFinalized({ ...pub, getChainId: async () => 1 }, attempt, wallet), false);
  for (const nonce of [7, 6]) assert.equal(await launchNonceFinalized({ ...pub, getTransactionCount: async () => nonce }, attempt, wallet), false);
  assert.equal(await launchNonceFinalized({ ...pub, getTransactionCount: async (args) => args.blockTag === "finalized" ? 7 : 100 }, attempt, wallet), false, "a pending nonce proves nothing");
  assert.equal(await launchNonceFinalized({ ...pub, getTransactionCount: async () => { throw Error("finality unavailable"); } }, attempt, wallet), false);
});

test("identity capture requires exact original hash, wallet and chain and fails closed on missing reads", async () => {
  const tx = { hash, from: wallet, nonce: 7 };
  const pub = { getChainId: async () => 8453, getTransaction: async () => tx } as unknown as Pick<PublicClient, "getChainId" | "getTransaction">;
  assert.deepEqual(await captureLaunchIdentity(pub, "base", hash, wallet), { hash, chainId: 8453, sender: wallet, nonce: 7 });
  for (const changed of [{ ...tx, hash: `0x${"cd".repeat(32)}` }, { ...tx, from: `0x${"34".repeat(20)}` }, { ...tx, nonce: -1 }]) {
    assert.equal(await captureLaunchIdentity({ ...pub, getTransaction: async () => changed } as typeof pub, "base", hash, wallet), undefined);
  }
  assert.equal(await captureLaunchIdentity({ ...pub, getChainId: async () => 1 }, "base", hash, wallet), undefined);
  assert.equal(await captureLaunchIdentity({ ...pub, getTransaction: async () => { throw Error("not found"); } }, "base", hash, wallet), undefined);
});
