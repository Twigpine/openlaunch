import { test } from "node:test";
import assert from "node:assert/strict";
import { resetMock, getMock } from "@/lib/db-mock";
import * as ed from "./editServer.ts";

// These tests exercise applySignedEdit with mocked DB and RPC (TEST_MOCK_DB=1
// swaps @/lib/db and @/lib/chain for mocks). The mock state lives on globalThis.

const CHAIN = "base";
const TOKEN = "0x" + "11".repeat(20);
const WALLET = "0x" + "ab".repeat(20);
const NONCE = "a".repeat(32);
const SIG = "0x" + "c".repeat(130);
// Fixed expiry so seedNonce and editRequest produce the same ISO string
const EXPIRES_AT = Date.now() + 300_000;
const EXPIRES_AT_ISO = new Date(EXPIRES_AT).toISOString();

function seedNonce(used = false) {
  const m = getMock();
  m.nonceRows[NONCE] = {
    nonce: NONCE,
    used_at: used ? "2026-01-01T00:00:00Z" : null,
    wallet: WALLET.toLowerCase(),
    token: TOKEN.toLowerCase(),
    chain_id: 8453,
    expires_at: EXPIRES_AT_ISO,
  };
}

function seedLauncher() {
  const m = getMock();
  m.launcherRows[TOKEN.toLowerCase()] = {
    launcher: WALLET.toLowerCase(),
    name: "Test",
    symbol: "TST",
  };
}

function editRequest(overrides: Record<string, unknown> = {}) {
  return {
    chain: CHAIN,
    token: TOKEN,
    wallet: WALLET,
    nonce: NONCE,
    expiresAt: EXPIRES_AT,
    signature: SIG,
    fields: { description: "hello" },
    ...overrides,
  };
}

// ── Finding 2: nonce consumed before verifyMessage ──

test("applySignedEdit: RPC error during verify does NOT consume the nonce (returns 503)", async () => {
  resetMock();
  seedNonce();
  seedLauncher();
  const m = getMock();
  m.verifyShouldThrow = true; // simulate RPC blip
  m.verifyResult = false;

  const r = await ed.applySignedEdit(editRequest());

  // BUG (current code): returns 401 "signature does not match" and nonce is consumed.
  // FIX (expected):   returns 503, nonce stays reusable.
  assert.equal(r.ok, false, "should fail");
  assert.equal(r.status, 503, "RPC error should be 503, not 401");
  // The nonce must NOT be consumed
  assert.equal(m.nonceRows[NONCE].used_at, null, "nonce must not be consumed on RPC error");
  assert.equal(m.metaInserted, false, "metadata must not be written on RPC error");
});

test("applySignedEdit: invalid signature does NOT consume the nonce (returns 401)", async () => {
  resetMock();
  seedNonce();
  seedLauncher();
  const m = getMock();
  m.verifyShouldThrow = false;
  m.verifyResult = false; // signature is genuinely invalid

  const r = await ed.applySignedEdit(editRequest());

  assert.equal(r.ok, false, "should fail");
  assert.equal(r.status, 401, "invalid signature should be 401");
  // The nonce must NOT be consumed when the signature is invalid
  assert.equal(m.nonceRows[NONCE].used_at, null, "nonce must not be consumed on invalid signature");
});

test("applySignedEdit: transport-level outage returns 503, not 401 (verifyMessage returns false on an offline transport)", async () => {
  // viem 2.55.19's verifyMessage returns false (rather than throwing) when the
  // RPC transport is unreachable, so without a liveness probe an outage would
  // surface as 401 "signature does not match". This drives a REAL viem client
  // with a dead transport through applySignedEdit (transportOutage swaps the
  // chain mock for createPublicClient with an unreachable URL), exercising the
  // same RPC-dependent verifyErc6492 path used for smart-wallet verification.
  resetMock();
  seedNonce();
  seedLauncher();
  const m = getMock();
  m.transportOutage = true;

  const r = await ed.applySignedEdit(editRequest());

  assert.equal(r.ok, false, "should fail");
  assert.equal(r.status, 503, "transport outage should be 503, not 401");
  assert.equal(m.nonceRows[NONCE].used_at, null, "nonce must not be consumed on outage");
  assert.equal(m.metaInserted, false, "metadata must not be written on outage");
});

test("applySignedEdit: valid signature consumes the nonce and writes metadata", async () => {
  resetMock();
  seedNonce();
  seedLauncher();
  const m = getMock();
  m.verifyShouldThrow = false;
  m.verifyResult = true;

  const r = await ed.applySignedEdit(editRequest());

  assert.equal(r.ok, true, "should succeed");
  assert.notEqual(m.nonceRows[NONCE].used_at, null, "nonce should be consumed on success");
  assert.equal(m.metaInserted, true, "metadata should be written on success");
});

test("applySignedEdit: an X profile link in the fields is accepted and written", async () => {
  resetMock();
  seedNonce();
  seedLauncher();
  const m = getMock();
  m.verifyShouldThrow = false;
  m.verifyResult = true;

  const r = await ed.applySignedEdit(editRequest({ fields: { description: "hello", x_handle: "https://x.com/openlaunch_lol?s=21" } }));

  assert.equal(r.ok, true, "should succeed");
  assert.equal(m.metaInserted, true, "metadata should be written");
});

test("applySignedEdit: a link to another site in the X field is a 400 and leaves the nonce alone", async () => {
  resetMock();
  seedNonce();
  seedLauncher();
  const m = getMock();
  m.verifyShouldThrow = false;
  m.verifyResult = true;

  const r = await ed.applySignedEdit(editRequest({ fields: { x_handle: "https://evil.com/openlaunch_lol" } }));

  assert.equal(r.ok, false, "should fail");
  assert.equal(r.status, 400);
  assert.equal(m.nonceRows[NONCE].used_at, null, "nonce must not be consumed");
  assert.equal(m.metaInserted, false, "metadata must not be written");
});

test("applySignedEdit: metadata write failure rolls back the nonce consume (transaction)", async () => {
  resetMock();
  seedNonce();
  seedLauncher();
  const m = getMock();
  m.verifyResult = true;
  m.metaInsertShouldThrow = true; // metadata INSERT fails

  // The metadata write throws inside db.begin(). The transaction rolls back
  // (nonce used_at restored to null) and the error propagates. In production
  // the route handler or Next.js catches it as a 500.
  await assert.rejects(ed.applySignedEdit(editRequest()), /mock metadata write failed/);
  // The nonce must be rolled back: used_at restored to null
  assert.equal(m.nonceRows[NONCE].used_at, null, "nonce must be rolled back when metadata write fails");
  assert.equal(m.metaInserted, false, "metadata must not be written");
});

test("applySignedEdit: wrong wallet in nonce row is rejected (predicate match)", async () => {
  resetMock();
  seedNonce();
  seedLauncher();
  const m = getMock();
  m.verifyResult = true;
  // Corrupt the wallet in the nonce row so it doesn't match the request
  m.nonceRows[NONCE].wallet = "0x" + "99".repeat(20);

  const r = await ed.applySignedEdit(editRequest());

  assert.equal(r.ok, false, "should fail when nonce wallet doesn't match");
  assert.equal(r.status, 401, "mismatched nonce should be 401");
  assert.equal(m.nonceRows[NONCE].used_at, null, "nonce must not be consumed on wallet mismatch");
});

test("applySignedEdit: wrong chain_id in nonce row is rejected (predicate match)", async () => {
  resetMock();
  seedNonce();
  seedLauncher();
  const m = getMock();
  m.verifyResult = true;
  m.nonceRows[NONCE].chain_id = 999;

  const r = await ed.applySignedEdit(editRequest());

  assert.equal(r.ok, false, "should fail when nonce chain_id doesn't match");
  assert.equal(r.status, 401, "mismatched chain_id should be 401");
});

test("applySignedEdit: expired expiresAt is rejected at input validation (400)", async () => {
  resetMock();
  seedNonce();
  seedLauncher();
  const m = getMock();
  m.verifyResult = true;

  // An expired expiresAt is rejected at line 54 before reaching the nonce
  // consume. The SQL expires_at > now() predicate is defense-in-depth.
  const r = await ed.applySignedEdit(editRequest({ expiresAt: Date.now() - 1000 }));

  assert.equal(r.ok, false, "should fail when expiresAt is in the past");
  assert.equal(r.status, 400, "expired expiresAt should be 400 (input validation)");
  assert.equal(m.nonceRows[NONCE].used_at, null, "nonce must not be consumed on expired request");
});

test("applySignedEdit: already-used nonce is rejected (401)", async () => {
  resetMock();
  seedNonce(true); // already used
  seedLauncher();
  const m = getMock();
  m.verifyResult = true;

  const r = await ed.applySignedEdit(editRequest());

  assert.equal(r.ok, false, "should fail");
  assert.equal(r.status, 401, "reused nonce should be 401");
});

// ── Finding 1: rateLimited keyed on unproven wallet ──

test("rateLimited: 10 hits on a wallet key 429s the 11th (the DoS mechanism)", () => {
  const key = `test:wallet:doz-${Math.random()}`;
  for (let i = 0; i < 10; i++) {
    assert.equal(ed.rateLimited(key, 10), false, `hit ${i + 1} should be allowed`);
  }
  assert.equal(ed.rateLimited(key, 10), true, "11th hit should be rate-limited");
});

test("rateLimited: a different wallet key is unaffected (cross-wallet isolation)", () => {
  const victim = `test:wallet:vic-${Math.random()}`;
  const attacker = `test:wallet:atk-${Math.random()}`;
  for (let i = 0; i < 10; i++) ed.rateLimited(victim, 10);
  assert.equal(ed.rateLimited(victim, 10), true, "victim frozen");
  assert.equal(ed.rateLimited(attacker, 10), false, "attacker key unaffected");
});

// ── Finding 1: wallet rate limit must not be spent before the signature is verified ──

test("applySignedEdit: 10 requests with an invalid signature do NOT freeze the wallet (rate limit only after verify)", async () => {
  // An attacker sends 10 edit requests with wallet=victim but a bad signature.
  // Before the fix, the route spent the wallet bucket before applySignedEdit,
  // so the victim's next real edit got 429. After the fix, the wallet bucket
  // is only spent after the signature is verified, so the victim is unaffected.
  resetMock();
  seedNonce();
  seedLauncher();
  const m = getMock();
  m.verifyShouldThrow = false;
  m.verifyResult = false; // invalid signature

  for (let i = 0; i < 10; i++) {
    const r = await ed.applySignedEdit(editRequest());
    assert.equal(r.ok, false, `attempt ${i + 1} should fail`);
    assert.equal(r.status, 401, `attempt ${i + 1} should be 401 (invalid sig)`);
  }

  // The nonce must still be unused (verify failed, so nonce was not consumed)
  assert.equal(m.nonceRows[NONCE].used_at, null, "nonce must not be consumed after 10 invalid-sig attempts");

  // Now the real creator sends a valid signed edit — it must NOT be rate-limited
  m.verifyResult = true;
  const r = await ed.applySignedEdit(editRequest());
  assert.equal(r.ok, true, "creator's valid edit must succeed (wallet bucket not frozen by attacker)");
  assert.equal(m.metaInserted, true, "metadata should be written");
});

test("issueNonce: creator can get nonces without a wallet-keyed limit (no unauthenticated wallet bucket)", async () => {
  // The nonce endpoint is unauthenticated (no signature), so a wallet-keyed
  // rate limit after the launcher check would still be abusable: an attacker
  // who knows the creator's public address passes the launcher check and
  // spends the wallet bucket. The fix removes the wallet limit entirely;
  // the IP limit in the route is the only limit on this endpoint.
  resetMock();
  seedLauncher();

  // 11 requests with the creator's wallet must all succeed (no wallet bucket)
  for (let i = 0; i < 11; i++) {
    const n = await ed.issueNonce(CHAIN, TOKEN, WALLET);
    assert.ok(n && "nonce" in n, `attempt ${i + 1} by creator should return a nonce`);
  }
});

test("issueNonce: non-creator requests return null", async () => {
  resetMock();
  seedLauncher();
  // A wallet that is not the launcher gets null
  const n = await ed.issueNonce(CHAIN, TOKEN, "0x" + "ff".repeat(20));
  assert.equal(n, null, "non-creator should get null");
});
