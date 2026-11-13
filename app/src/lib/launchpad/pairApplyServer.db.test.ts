import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import postgres from "postgres";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { setDb, type Db } from "../../../scripts/reorg-db-test-db.ts";
import { buildPairQuoteMessage, PAIR_QUOTE_LOCK_MS, PAIR_UNPAID_EXPIRE_MS } from "./pairApply.ts";

// Opt-in real PostgreSQL tests. Only explicit loopback URLs, owned random schemas and synthetic signatures/prices.
// RUN_PAIR_DB_TESTS=1 PAIR_TEST_DATABASE_URL=postgres://...@127.0.0.1:PORT/audit
// npx tsx --conditions=react-server --tsconfig tsconfig.pair-db-test.json --test src/lib/launchpad/pairApplyServer.db.test.ts
test("pair quote authority, bounded reservations and historical valuation on PostgreSQL", { skip: process.env.RUN_PAIR_DB_TESTS !== "1" }, async (t) => {
  const endpoint = process.env.PAIR_TEST_DATABASE_URL;
  assert.ok(endpoint, "PAIR_TEST_DATABASE_URL is required");
  const url = new URL(endpoint);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    && url.port && !url.search && !url.hash, "pair tests require explicit loopback host/port without URL options");
  const schema = `pair_security_${randomBytes(8).toString("hex")}`;
  const admin = postgres(endpoint, { max: 1, onnotice: () => {} });
  const db = postgres(endpoint, { max: 8, connection: { search_path: schema, application_name: schema }, onnotice: () => {} });
  let created = false;
  const previous = process.env.PAIRS_APPLY;
  process.env.PAIRS_APPLY = "on";
  t.mock.method(globalThis, "fetch", async () => { throw new Error("external fetch disabled in pair tests"); });
  t.after(async () => {
    setDb(null);
    if (previous === undefined) delete process.env.PAIRS_APPLY; else process.env.PAIRS_APPLY = previous;
    try { await db.end({ timeout: 5 }); } finally {
      try {
        if (created) { assert.match(schema, /^pair_security_[0-9a-f]{16}$/); await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`); }
      } finally { await admin.end({ timeout: 5 }); }
    }
  });
  assert.match(schema, /^pair_security_[0-9a-f]{16}$/);
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  created = true;
  assert.equal((await db`SELECT current_schema() AS name`)[0].name, schema);
  const schemaSql = readFileSync(path.join(process.cwd(), "db/schema.sql"), "utf8")
    .replaceAll("FROM pg_constraint WHERE", "FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND")
    .replaceAll("WHERE t.relname =", "WHERE c.connamespace = current_schema()::regnamespace AND t.relname =");
  await db.unsafe(schemaSql);
  setDb(db as unknown as Db);
  const { quoteFee, getApplication, expireStaleApplications, revaluePairBurns } = await import("./pairApplyServer.ts");
  const { POST } = await import("../../app/api/pairs/application/[id]/quote/route.ts");
  const owner = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const wallet = owner.address.toLowerCase();
  const token = "0x2222222222222222222222222222222222222222";
  await db`INSERT INTO bb_launch_sync_cursor (chain_id, cursor_block, reorg_version, rebuilding_until) VALUES (8453, 100, 1, NULL)
    ON CONFLICT (chain_id) DO UPDATE SET reorg_version = 1, rebuilding_until = NULL`;
  async function seed(ageMs = 1_000) {
    await db`TRUNCATE bb_pair_applications, bb_pair_burns, bb_post_nonces RESTART IDENTITY CASCADE`;
    const [app] = await db`INSERT INTO bb_pair_applications (chain_id, address, applicant, code, symbol, name, decimals, price_kind, price_pool, price_quote, precheck, fee_usd, created_at)
      VALUES (8453, ${token}, ${wallet}, 'OL-TEST', 'TEST', 'Synthetic pair', 18, 'launch', ${token}, ${wallet}, '{}', 200,
        clock_timestamp() - ${`${ageMs} milliseconds`}::interval) RETURNING *`;
    return app;
  }
  async function signed(id = 1, signer = owner, nonce = randomBytes(16).toString("hex"), ts = Date.now()) {
    const intent = { id, wallet: signer.address.toLowerCase(), nonce, ts };
    return { ...intent, signature: await signer.signMessage({ message: buildPairQuoteMessage(intent) }) };
  }
  const isFailure = (value: Awaited<ReturnType<typeof quoteFee>>, status: number) => assert.ok(value && "ok" in value && !value.ok && value.status === status, JSON.stringify(value));
  const row = async () => (await db`SELECT * FROM bb_pair_applications WHERE id = 1`)[0];
  const nonceCount = async () => Number((await db`SELECT count(*) AS n FROM bb_post_nonces`)[0].n);
  const payment = async (tx: string, sentAt: Date, usd: number | null = null, whole = "100000") => db`
    INSERT INTO bb_pair_burns (chain_id, tx_hash, log_index, application_id, sender, twig, usd, block_number, block_time)
      VALUES (8453, ${tx}, 0, 1, ${stranger.address.toLowerCase()}, ${whole}, ${usd}, 100, ${sentAt})`;

  await t.test("unsigned route and another wallet cannot reserve a quote", async () => {
    await seed();
    const response = await POST(new Request("http://localhost/api/pairs/application/1/quote", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "1" }) });
    assert.equal(response.status, 400);
    isFailure(await quoteFee(1, await signed(1, stranger)), 403);
    assert.equal((await row()).quote_until, null);
    assert.equal(await nonceCount(), 0);
  });
  await t.test("signatures bind identity, application, timestamp and action", async () => {
    await seed();
    const valid = await signed();
    const forged = await signed(1, stranger);
    isFailure(await quoteFee(1, { ...forged, wallet }), 401);
    isFailure(await quoteFee(1, await signed(2)), 401);
    isFailure(await quoteFee(1, { ...valid, ts: valid.ts + 1 }), 401);
    isFailure(await quoteFee(1, await signed(1, owner, undefined, Date.now() - 6 * 60_000)), 400);
    const signature = await owner.signMessage({ message: buildPairQuoteMessage(valid).replace("Action: quote", "Action: apply") });
    isFailure(await quoteFee(1, { ...valid, signature }), 401);
    assert.equal(await nonceCount(), 0);
  });
  await t.test("one signature creates one reservation across concurrent requests and replays", async () => {
    await seed();
    const payload = await signed();
    const outcomes = await Promise.all([quoteFee(1, payload), quoteFee(1, payload)]);
    assert.equal(outcomes.filter((q) => q && !("ok" in q)).length, 1);
    assert.equal(outcomes.filter((q) => q && "ok" in q && q.status === 401).length, 1);
    assert.equal(await nonceCount(), 1);
    const before = (await row()).quote_until;
    isFailure(await quoteFee(1, payload), 401);
    assert.deepEqual((await row()).quote_until, before);
  });
  await t.test("the signed route accepts an applicant while simultaneous fresh intents keep one lock", async () => {
    await seed();
    const intents = await Promise.all([signed(), signed()]);
    const replies = await Promise.all(intents.map((intent) => POST(new Request("http://localhost/api/pairs/application/1/quote", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intent),
    }), { params: Promise.resolve({ id: "1" }) })));
    assert.deepEqual(replies.map((r) => r.status), [200, 200]);
    const quotes = await Promise.all(replies.map((r) => r.json()));
    assert.deepEqual(quotes[0], quotes[1]);
    assert.equal(await nonceCount(), 2);
  });
  await t.test("a failed reservation update rolls back the nonce so the signed intent can be retried", async () => {
    await seed();
    const intent = await signed();
    await db.unsafe(`CREATE FUNCTION reject_test_quote() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic quote write failure'; END $$;
      CREATE TRIGGER reject_test_quote BEFORE UPDATE ON bb_pair_applications FOR EACH ROW EXECUTE FUNCTION reject_test_quote()`);
    try {
      await assert.rejects(quoteFee(1, intent), /synthetic quote write failure/);
      assert.equal(await nonceCount(), 0);
      assert.equal((await row()).quote_until, null);
    } finally {
      await db.unsafe("DROP TRIGGER reject_test_quote ON bb_pair_applications; DROP FUNCTION reject_test_quote()");
    }
    const q = await quoteFee(1, intent);
    assert.ok(q && !("ok" in q));
    assert.equal(await nonceCount(), 1);
  });
  await t.test("rebuilding or disputed payment history cannot open a new reservation", async () => {
    await seed();
    await db`UPDATE bb_launch_sync_cursor SET rebuilding_until = 200 WHERE chain_id = 8453`;
    try { isFailure(await quoteFee(1, await signed()), 503); }
    finally { await db`UPDATE bb_launch_sync_cursor SET rebuilding_until = NULL WHERE chain_id = 8453`; }
    await db`UPDATE bb_pair_applications SET payment_reorg = true WHERE id = 1`;
    isFailure(await quoteFee(1, await signed()), 409);
    assert.equal((await row()).quote_until, null);
    assert.equal(await nonceCount(), 0);
  });
  await t.test("a live quote is public for sponsors and new signatures cannot extend it", async () => {
    await seed();
    const q = await quoteFee(1, await signed());
    assert.ok(q && !("ok" in q));
    assert.deepEqual(await quoteFee(1, await signed()), q);
    assert.deepEqual((await getApplication(1))?.quote, q);
    assert.equal(await nonceCount(), 2);
  });
  await t.test("late unpaid reservations stop at the 48-hour deadline", async () => {
    const app = await seed(PAIR_UNPAID_EXPIRE_MS - 5 * 60_000);
    const q = await quoteFee(1, await signed());
    assert.ok(q && !("ok" in q));
    const deadline = new Date(app.created_at).getTime() + PAIR_UNPAID_EXPIRE_MS;
    assert.equal(Date.parse(q.until), deadline);
    assert.equal(new Date((await row()).last_quote_until).getTime(), deadline);
    await seed(PAIR_UNPAID_EXPIRE_MS + 1_000);
    isFailure(await quoteFee(1, await signed()), 409);
    assert.equal((await row()).quote_until, null);
    assert.equal(await nonceCount(), 0);
  });
  await t.test("pre-upgrade live locks remain honored but cannot be renewed after the unpaid deadline", async () => {
    await seed(PAIR_UNPAID_EXPIRE_MS + 60_000);
    await db`UPDATE bb_pair_applications SET quote_twig = 100000, quote_price_usd = 0.00002, quote_at = now(), quote_until = now() + interval '20 minutes', last_quote_until = now() + interval '20 minutes' WHERE id = 1`;
    const before = (await row()).quote_until;
    const q = await quoteFee(1, await signed());
    assert.ok(q && !("ok" in q));
    assert.equal(Date.parse(q.until), new Date(before).getTime());
    await db`UPDATE bb_pair_applications SET quote_until = now() - interval '1 second' WHERE id = 1`;
    isFailure(await quoteFee(1, await signed()), 409);
  });
  await t.test("expiry preserves the last reservation's settlement grace even after its active fields clear", async () => {
    await seed(PAIR_UNPAID_EXPIRE_MS + 2 * 3_600_000);
    await db`UPDATE bb_pair_applications SET last_quote_until = now() - interval '30 minutes' WHERE id = 1`;
    assert.equal(await expireStaleApplications(), 0);
    assert.equal((await row()).status, "open");
    await db`UPDATE bb_pair_applications SET last_quote_until = now() - interval '61 minutes' WHERE id = 1`;
    assert.equal(await expireStaleApplications(), 1);
    assert.equal((await row()).status, "expired");
  });
  await t.test("recorded sponsor payments retain top-up access after 48 hours", async () => {
    await seed(PAIR_UNPAID_EXPIRE_MS + 3_600_000);
    await payment("sponsor-payment", new Date(), 50);
    await db`UPDATE bb_pair_applications SET paid_usd = 50 WHERE id = 1`;
    const q = await quoteFee(1, await signed());
    assert.ok(q && !("ok" in q));
    const app = await row();
    assert.equal(new Date(app.quote_until).getTime() - new Date(app.quote_at).getTime(), PAIR_QUOTE_LOCK_MS);
    assert.equal(await expireStaleApplications(), 0);
  });
  await t.test("old live-priced burns preserve a newer quote for a later in-window sponsor burn", async () => {
    await seed(2 * 3_600_000);
    await db`UPDATE bb_pair_applications SET quote_twig = 100000, quote_price_usd = 0.000031, quote_at = now() - interval '10 minutes', quote_until = now() + interval '20 minutes', last_quote_until = now() + interval '20 minutes' WHERE id = 1`;
    const before = await row();
    await payment("old-burn", new Date(Date.now() - 20 * 60_000));
    await revaluePairBurns();
    assert.deepEqual((await row()).quote_until, before.quote_until, "an old live-priced burn must not consume the newer lock");
    assert.equal((await db`SELECT priced_by FROM bb_pair_burns WHERE tx_hash = 'old-burn'`)[0].priced_by, "live");
    await payment("in-window-burn", new Date(Date.now() - 5 * 60_000));
    await revaluePairBurns(Date.now() + 61_000);
    const [burn] = await db`SELECT usd, priced_by FROM bb_pair_burns WHERE tx_hash = 'in-window-burn'`;
    assert.equal(burn.priced_by, "quote");
    assert.equal(burn.usd, 100_000 * 0.000031);
    const after = await row();
    assert.equal(after.quote_until, null);
    assert.deepEqual(after.last_quote_until, before.last_quote_until);
  });
});
