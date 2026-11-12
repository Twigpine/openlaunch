import { test } from "node:test";
import assert from "node:assert/strict";
import { getMock, resetMock } from "@/lib/db-mock";
import { admitAdmin, deleteProfile } from "./server";

// Exercise the shared admission path through its real public entry points.
// Only the DB uniqueness constraint and contract-wallet RPC are simulated.
function fixture(byte: string) {
  resetMock();
  const wallet = `0x${byte.repeat(20)}`;
  const nonces = new Set<string>();
  const m = getMock();
  let valid = true;
  m.publicClient = {
    getCode: async () => "0x01",
    verifyMessage: async () => valid,
    getChainId: async () => 8453,
  };
  m.query = async (sql, values) => {
    if (sql.includes("INSERT INTO bb_profile_nonces")) {
      const nonce = String(values[0]);
      if (nonces.has(nonce)) throw Object.assign(new Error("duplicate profile nonce"), { code: "23505" });
      nonces.add(nonce);
    }
    // The synthetic wallet has no profile; deletion is an idempotent no-op
    // after authentication, so no unrelated profile rules enter these tests.
    return [];
  };
  const request = (n: number) => ({ chain: "base", wallet, nonce: n.toString(16).padStart(32, "0"), ts: Date.now(), signature: "0x01" });
  return { wallet, nonces, request, setValid: (value: boolean) => { valid = value; } };
}

test("profile admission: a used valid signature cannot spend the wallet allowance", async () => {
  const f = fixture("ae");
  const original = f.request(1);
  assert.equal((await deleteProfile(original)).ok, true);
  for (let i = 0; i < 12; i++) {
    const replay = await deleteProfile(original);
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.status, 401, "consumed nonce is rejected before wallet accounting");
  }
  assert.equal((await deleteProfile(f.request(2))).ok, true, "a fresh signed action retains its allowance");
  assert.equal(f.nonces.size, 2);
});

test("profile admission: twelve fresh actions retain the quota and over-quota nonces are consumed", async () => {
  const f = fixture("af");
  for (let i = 1; i <= 12; i++) assert.equal((await deleteProfile(f.request(i))).ok, true);
  const excess = f.request(13);
  const denied = await deleteProfile(excess);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.status, 429);
  assert.ok(f.nonces.has(excess.nonce), "fresh over-quota attempt consumes its nonce");
  const replay = await deleteProfile(excess);
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.status, 401);
});

test("admin admission: concurrent copies debit the shared profile wallet quota once", async (t) => {
  const f = fixture("b0");
  const prior = process.env.ADMIN_WALLETS;
  process.env.ADMIN_WALLETS = f.wallet;
  t.after(() => { if (prior === undefined) delete process.env.ADMIN_WALLETS; else process.env.ADMIN_WALLETS = prior; });
  const original = f.request(1);
  const message = (wallet: string, nonce: string, ts: number) => `Synthetic admin action: ${wallet}:${nonce}:${ts}`;
  const responses = await Promise.all(Array.from({ length: 13 }, () => admitAdmin(original, message)));
  assert.equal(responses.filter((r) => r.ok).length, 1);
  assert.equal(responses.filter((r) => !r.ok && r.status === 401).length, 12);
  for (let i = 2; i <= 12; i++) assert.equal((await admitAdmin(f.request(i), message)).ok, true);
  const excess = await admitAdmin(f.request(13), message);
  assert.equal(excess.ok, false);
  if (!excess.ok) assert.equal(excess.status, 429);
});

test("profile admission: invalid signatures consume neither nonces nor wallet allowance", async () => {
  const f = fixture("b1");
  f.setValid(false);
  for (let i = 1; i <= 15; i++) {
    const denied = await deleteProfile(f.request(i));
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.status, 401);
  }
  assert.equal(f.nonces.size, 0);
  f.setValid(true);
  assert.equal((await deleteProfile(f.request(1))).ok, true);
});
