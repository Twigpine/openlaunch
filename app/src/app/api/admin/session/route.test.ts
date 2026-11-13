import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getMock, resetMock } from "../../../../lib/db-mock.ts";
import { buildAdminSignInMessage } from "../../../../lib/admin/signIn.ts";
import { POST } from "./route.ts";

let sequence = 0;
function fixture() {
  resetMock();
  const account = privateKeyToAccount(generatePrivateKey());
  const nonces = new Set<string>();
  let sessions = 0;
  let onRead: (() => Promise<void>) | undefined;
  getMock().query = async (sql, values) => {
    const nonce = String(values[0]);
    if (sql.includes("SELECT 1 FROM bb_admin_nonces")) {
      const open = nonces.has(nonce);
      await onRead?.();
      return open ? [{}] : [];
    }
    if (sql.includes("UPDATE bb_admin_nonces SET used_at")) {
      if (!nonces.delete(nonce)) return [];
      return [{ nonce }];
    }
    if (sql.includes("INSERT INTO bb_admin_sessions")) sessions++;
    return [];
  };
  async function signed() {
    const nonce = randomBytes(16).toString("hex");
    nonces.add(nonce);
    const message = buildAdminSignInMessage({ origin: "https://openlaunch.lol", address: account.address, nonce, issuedAt: new Date() });
    return { message, signature: await account.signMessage({ message }), nonce };
  }
  function submit(body: unknown) {
    return POST(new Request("http://localhost/api/admin/session", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://openlaunch.lol", "x-forwarded-for": `admin-quota-${++sequence}` }, body: JSON.stringify(body),
    }));
  }
  function barrier(count: number) {
    let arrived = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    onRead = async () => { if (++arrived === count) { onRead = undefined; release(); } await ready; };
  }
  return { account, nonces, sessions: () => sessions, signed, submit, barrier };
}

test("concurrent admin sign-in replays cannot consume the wallet's sign-in allowance", { timeout: 10_000 }, async (t) => {
  const f = fixture();
  const previous = process.env.ADMIN_WALLETS;
  process.env.ADMIN_WALLETS = f.account.address;
  t.after(() => { if (previous === undefined) delete process.env.ADMIN_WALLETS; else process.env.ADMIN_WALLETS = previous; });
  const original = await f.signed();
  f.barrier(12); // Every precheck sees the nonce open before any contender consumes it.
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.submit(original)));
  assert.equal(replies.filter((r) => r.status === 200).length, 1);
  assert.equal(replies.filter((r) => r.status === 401).length, 11);
  assert.equal(f.sessions(), 1);
  assert.equal((await f.submit(await f.signed())).status, 200, "fresh login retains its allowance");
  assert.equal(f.sessions(), 2);
});

test("fresh signed admin logins retain the cap and over-quota nonces cannot be replayed", async (t) => {
  const f = fixture();
  const previous = process.env.ADMIN_WALLETS;
  process.env.ADMIN_WALLETS = f.account.address;
  t.after(() => { if (previous === undefined) delete process.env.ADMIN_WALLETS; else process.env.ADMIN_WALLETS = previous; });
  for (let i = 0; i < 10; i++) assert.equal((await f.submit(await f.signed())).status, 200);
  const excess = await f.signed();
  assert.equal((await f.submit(excess)).status, 429);
  assert.equal(f.nonces.has(excess.nonce), false);
  assert.equal((await f.submit(excess)).status, 401);
  assert.equal(f.sessions(), 10);
});
