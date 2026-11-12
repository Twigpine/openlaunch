import assert from "node:assert/strict";
import test from "node:test";
import { pendingLaunch, pendingLaunchServer, rememberPendingLaunch, subscribePendingLaunch } from "./pending-launch.ts";

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
