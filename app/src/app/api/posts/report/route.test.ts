import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getMock, resetMock } from "../../../../lib/db-mock.ts";
import { buildReportMessage } from "../../../../lib/launchpad/posts.ts";
import { POST } from "./route.ts";

let requestSequence = 0;
function fixture() {
  resetMock();
  const signer = privateKeyToAccount(generatePrivateKey());
  const nonces = new Set<string>();
  let writes = 0;
  getMock().publicClient = { verifyMessage };
  getMock().query = async (sql, values) => {
    if (sql.includes("SELECT chain_id, wallet FROM bb_posts")) return [{ chain_id: 8453, wallet: "0x1111111111111111111111111111111111111111" }];
    if (sql.includes("SELECT id FROM bb_posts") && sql.includes("FOR UPDATE")) return [{ id: values[0] }];
    if (sql.includes("SELECT (SELECT count(*)")) return [{ n: 1n }];
    if (sql.includes("INSERT INTO bb_post_nonces")) {
      const nonce = String(values[0]);
      if (nonces.has(nonce)) throw new Error("duplicate nonce");
      nonces.add(nonce);
    }
    if (sql.includes("INSERT INTO bb_post_reports")) writes++;
    if (sql.includes("SELECT count(*)::bigint")) return [{ n: 1n }];
    if (sql.includes("UPDATE bb_posts") && sql.includes("RETURNING hidden")) return [{ hidden: false }];
    return [];
  };
  async function signed(postId = 1) {
    const input = { postId, wallet: signer.address, reason: "spam", nonce: randomBytes(16).toString("hex"), ts: Date.now() };
    return { ...input, signature: await signer.signMessage({ message: buildReportMessage(input) }) };
  }
  function submit(input: unknown, ip = `report-test-${++requestSequence}`) {
    // Calls the real route with a local Request; no HTTP/RPC traffic is sent.
    return POST(new Request("http://localhost/api/posts/report", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(input),
    }));
  }
  return { signed, submit, nonces, writes: () => writes };
}

test("invalid reports cannot consume the named wallet's reporting allowance", async () => {
  const f = fixture();
  const input = await f.signed();
  for (let i = 0; i < 21; i++) assert.equal((await f.submit({ ...input, reason: "invalid" })).status, 400);
  for (let i = 0; i < 21; i++) assert.equal((await f.submit({ ...input, signature: "0x1234" })).status, 401);
  assert.equal(f.nonces.size, 0);
  assert.equal(f.writes(), 0);
  assert.equal((await f.submit(input)).status, 200);
  assert.equal(f.writes(), 1);
});

test("replays do not spend allowance; twenty fresh signed actions retain the wallet cap", async () => {
  const f = fixture();
  const first = await f.signed();
  assert.equal((await f.submit(first)).status, 200);
  for (let i = 0; i < 21; i++) assert.equal((await f.submit(first)).status, 401);
  for (let i = 1; i < 20; i++) {
    const input = await f.signed(i + 1);
    // Case changes must not create a second wallet allowance.
    assert.equal((await f.submit({ ...input, wallet: input.wallet.toLowerCase() })).status, 200);
  }
  assert.equal((await f.submit(await f.signed(21))).status, 429);
  assert.equal(f.writes(), 20);
});

test("the IP limit still rejects excess invalid requests before verification", async () => {
  const f = fixture();
  const ip = `report-limit-${++requestSequence}`;
  const input = await f.signed();
  for (let i = 0; i < 20; i++) assert.equal((await f.submit({ ...input, signature: "0x1234" }, ip)).status, 401);
  assert.equal((await f.submit(input, ip)).status, 429);
  assert.equal(f.nonces.size, 0);
  assert.equal(f.writes(), 0);
});

test("client-supplied forwarding prefixes cannot reset a proxy-appended IP bucket", async () => {
  fixture();
  const proxyClient = `proxy-client-${++requestSequence}`;
  for (let i = 0; i <= 20; i++) {
    const response = await POST(new Request("http://localhost/api/posts/report", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `untrusted-prefix-${i}, ${proxyClient}` }, body: "{}",
    }));
    assert.equal(response.status, i < 20 ? 400 : 429);
  }
});
