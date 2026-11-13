import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { setPostsTestDb, type Db } from "../../../scripts/posts-db-test-db.ts";
import { setPostsTestClient } from "../../../scripts/posts-db-test-chain.ts";
import { POST_MIN_GAP_MS, buildPostMessage, buildReportMessage } from "./posts.ts";

// Opt-in, real PostgreSQL concurrency checks. The URL must be loopback, with a port and no options. Each run owns a
// random schema and drops only that schema; it never reads application environment files.
// RUN_POSTS_DB_TESTS=1 POSTS_TEST_DATABASE_URL=postgres://...@127.0.0.1:PORT/audit
// npx tsx --conditions=react-server --tsconfig tsconfig.posts-db-test.json --test src/lib/launchpad/postsServer.db.test.ts
test("posting limits and nonce consumption stay atomic across PostgreSQL connections", { skip: process.env.RUN_POSTS_DB_TESTS !== "1" }, async (t) => {
  const endpoint = process.env.POSTS_TEST_DATABASE_URL;
  assert.ok(endpoint, "POSTS_TEST_DATABASE_URL is required for the opted-in test");
  const parsed = new URL(endpoint);
  assert.ok(["postgres:", "postgresql:"].includes(parsed.protocol)
    && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    && parsed.port && !parsed.search && !parsed.hash,
  "posting tests require an explicit loopback PostgreSQL host and port, without URL options");
  const schema = `post_security_${randomBytes(8).toString("hex")}`;
  assert.match(schema, /^post_security_[0-9a-f]{16}$/);
  const root = postgres(endpoint, { max: 1, onnotice: () => {} });
  const sql = postgres(endpoint, { max: 8, connection: { search_path: schema, application_name: schema }, onnotice: () => {} });
  let schemaCreated = false;
  t.after(async () => {
    setPostsTestDb(null);
    try {
      await sql.end({ timeout: 5 });
    } finally {
      try {
        if (schemaCreated) {
          assert.match(schema, /^post_security_[0-9a-f]{16}$/);
          await root.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        }
      } finally {
        await root.end({ timeout: 5 });
      }
    }
  });
  await root.unsafe(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  const [scope] = await sql<{ schema: string }[]>`SELECT current_schema() AS schema`;
  assert.equal(scope.schema, schema, "posting fixture writes must use the owned schema");
  await sql.unsafe(`
    CREATE TABLE bb_launches (chain_id integer, token text, launcher text, supply numeric);
    CREATE TABLE bb_token_settings (chain_id integer, token text, comments_muted boolean);
    CREATE TABLE bb_posts (id bigserial PRIMARY KEY, chain_id integer NOT NULL, token text NOT NULL, wallet text NOT NULL, parent_id bigint REFERENCES bb_posts(id), body text NOT NULL, tag text, signature text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), hidden boolean NOT NULL DEFAULT false, hidden_by text, reports integer NOT NULL DEFAULT 0);
    CREATE TABLE bb_post_nonces (nonce text PRIMARY KEY, wallet text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE bb_launch_swaps (trader text);
    CREATE TABLE bb_post_reports (post_id bigint NOT NULL REFERENCES bb_posts(id) ON DELETE CASCADE, wallet text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (post_id, wallet));
  `);
  setPostsTestDb(sql as unknown as Db);
  let beforeVerification: (() => Promise<void>) | null = null;
  setPostsTestClient({
    readContract: async () => 1n,
    verifyMessage: async (args) => {
      const valid = await verifyMessage(args);
      if (beforeVerification) await beforeVerification();
      return valid;
    },
  });
  const { POST } = await import("../../app/api/posts/route.ts");
  const { reportPost } = await import("./postsServer.ts");
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = account.address.toLowerCase();
  const token = "0x2222222222222222222222222222222222222222";
  await sql`INSERT INTO bb_launches VALUES (8453, ${token}, ${wallet}, 1000000)`;
  const postCount = async () => Number((await sql`SELECT count(*) AS n FROM bb_posts`)[0].n);
  const nonceCount = async () => Number((await sql`SELECT count(*) AS n FROM bb_post_nonces`)[0].n);
  async function clear(seed = 0) {
    beforeVerification = null;
    await sql`TRUNCATE bb_posts, bb_post_nonces RESTART IDENTITY CASCADE`;
    if (seed) await sql`INSERT INTO bb_posts (chain_id,token,wallet,body,signature,created_at) SELECT 8453, ${token}, ${wallet}, 'previous post', 'synthetic seed', now() - interval '1 minute' FROM generate_series(1, ${seed})`;
  }
  async function payload(signer = account, nonce = randomBytes(16).toString("hex")) {
    const ts = Date.now();
    const input = { chain: "base", token, wallet: signer.address.toLowerCase(), nonce, ts, parentId: null, body: "Synthetic integration post" };
    return { ...input, signature: await signer.signMessage({ message: buildPostMessage(input) }) };
  }
  async function submit(body: Awaited<ReturnType<typeof payload>>) {
    return POST(new Request("http://localhost/api/posts", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.240" }, body: JSON.stringify(body) }));
  }
  function barrier(count: number) {
    let arrived = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    beforeVerification = async () => { if (++arrived === count) release(); await ready; };
  }
  async function reporter() {
    const signer = privateKeyToAccount(generatePrivateKey());
    await sql`INSERT INTO bb_launch_swaps (trader) VALUES (${signer.address.toLowerCase()})`;
    return signer;
  }
  async function reportPayload(signer: typeof account, postId = 1) {
    const input = { postId, wallet: signer.address.toLowerCase(), nonce: randomBytes(16).toString("hex"), ts: Date.now(), reason: "spam" };
    return { ...input, signature: await signer.signMessage({ message: buildReportMessage(input) }) };
  }

  await t.test("sequential calls retain the 20-second gap", async () => {
    await clear();
    assert.equal((await submit(await payload())).status, 200);
    assert.equal((await submit(await payload())).status, 429);
    assert.equal(await postCount(), 1);
  });
  for (const skewMs of [-60_000, 60_000]) await t.test(`posting gaps use database time when the app clock is skewed by ${skewMs}ms`, async (t) => {
    await clear();
    const realNow = Date.now;
    t.mock.method(Date, "now", () => realNow() + skewMs);
    assert.equal((await submit(await payload())).status, 200);
    const immediate = await submit(await payload());
    assert.equal(immediate.status, 429, "an app clock ahead of PostgreSQL must not bypass the posting gap");
    assert.match((await immediate.json()).error, /^wait \d+s between posts$/);
    assert.equal(await postCount(), 1);
    assert.equal(await nonceCount(), 1);
    await sql`UPDATE bb_posts SET created_at = clock_timestamp() - interval '21 seconds'`;
    assert.equal((await submit(await payload())).status, 200, "an app clock behind PostgreSQL must not extend the posting gap");
    assert.equal(await postCount(), 2);
    assert.equal(await nonceCount(), 2);
  });
  await t.test("a post queued beyond the gap is timestamped after its wallet lock is released", { timeout: 45_000 }, async () => {
    await clear();
    const locker = await sql.reserve();
    let locked = false;
    let queued: Promise<Response> | undefined;
    try {
      await locker`SELECT pg_advisory_lock(hashtext(${`post:${wallet}`}))`;
      locked = true;
      queued = submit(await payload());
      const deadline = Date.now() + 5_000;
      for (;;) {
        const [state] = await root`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE application_name = ${schema} AND wait_event = 'advisory'`;
        if (state.waiting > 0) break;
        assert.ok(Date.now() < deadline, "the actual posting transaction must be waiting on the wallet lock");
        await delay(10);
      }
      await delay(POST_MIN_GAP_MS + 100);
      const [clock] = await root`SELECT clock_timestamp() AS released_at`;
      await locker`SELECT pg_advisory_unlock(hashtext(${`post:${wallet}`}))`;
      locked = false;
      const response = await queued;
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal((await submit(await payload())).status, 429, "lock wait must not backdate a post and permit an immediate second post");
      assert.ok(new Date(result.post.created_at).getTime() >= new Date(clock.released_at).getTime(), "created_at must use insertion time, not transaction-start time");
      assert.equal(await postCount(), 1);
    } finally {
      if (locked) await locker`SELECT pg_advisory_unlock(hashtext(${`post:${wallet}`}))`;
      locker.release();
      await queued?.catch(() => {});
    }
  });
  for (const skewMs of [0, -60_000, 60_000]) await t.test(`distinct signed nonces cannot bypass the gap concurrently with app clock skew ${skewMs}ms`, async (t) => {
    await clear();
    const realNow = Date.now;
    t.mock.method(Date, "now", () => realNow() + skewMs);
    barrier(2);
    const inputs = await Promise.all([payload(), payload()]);
    const responses = await Promise.all(inputs.map(submit));
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 429]);
    assert.equal(await postCount(), 1);
    assert.equal(await nonceCount(), 1, "a rejected quota attempt retains its unused nonce");
  });
  await t.test("the last daily allowance is shared atomically", async () => {
    await clear(59);
    barrier(2);
    const inputs = await Promise.all([payload(), payload()]);
    const responses = await Promise.all(inputs.map(submit));
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 429]);
    assert.equal(await postCount(), 60);
    assert.equal(await nonceCount(), 1);
  });
  await t.test("an already exhausted daily cap and invalid signatures write nothing", async () => {
    await clear(60);
    assert.equal((await submit(await payload())).status, 429);
    assert.equal(await nonceCount(), 0);
    await clear();
    assert.equal((await submit({ ...await payload(), signature: "0x1234" })).status, 401);
    assert.equal(await postCount(), 0);
    assert.equal(await nonceCount(), 0);
  });
  await t.test("the daily cap is rechecked after verification even when the short gap is clear", async () => {
    await clear(59);
    beforeVerification = async () => {
      beforeVerification = null;
      await sql`INSERT INTO bb_posts (chain_id,token,wallet,body,signature,created_at) VALUES (8453, ${token}, ${wallet}, 'another committed post', 'synthetic seed', now() - interval '1 minute')`;
    };
    const response = await submit(await payload());
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: "daily post limit reached" });
    assert.equal(await postCount(), 60);
    assert.equal(await nonceCount(), 0);
  });
  await t.test("a post insert failure rolls back its signing nonce", async () => {
    await clear();
    const input = await payload();
    await sql`ALTER TABLE bb_posts ADD CONSTRAINT audit_reject_body CHECK (body <> 'Synthetic integration post')`;
    try { await assert.rejects(submit(input)); } finally { await sql`ALTER TABLE bb_posts DROP CONSTRAINT audit_reject_body`; }
    assert.equal(await postCount(), 0);
    assert.equal(await nonceCount(), 0);
    assert.equal((await submit(input)).status, 200, "the same signature can be retried after storage recovers");
  });
  await t.test("different wallets can post independently", async () => {
    await clear();
    barrier(2);
    const second = privateKeyToAccount(generatePrivateKey());
    const inputs = await Promise.all([payload(), payload(second)]);
    const responses = await Promise.all(inputs.map(submit));
    assert.deepEqual(responses.map((r) => r.status), [200, 200]);
    assert.equal(await postCount(), 2);
  });
  await t.test("reusing a consumed nonce does not create a second post", async () => {
    await clear();
    const input = await payload();
    assert.equal((await submit(input)).status, 200);
    await sql`UPDATE bb_posts SET created_at = now() - interval '1 minute'`;
    assert.equal((await submit(input)).status, 401);
    assert.equal(await postCount(), 1);
  });
  await t.test("concurrent signed reports count distinct wallets and preserve automatic hiding", async () => {
    await clear(1);
    const reporters = await Promise.all(Array.from({ length: 6 }, () => reporter()));
    const inputs = await Promise.all(reporters.map((signer) => reportPayload(signer)));
    barrier(inputs.length);
    const results = await Promise.all(inputs.map(reportPost));
    assert.ok(results.every((r) => r.ok));
    const [post] = await sql`SELECT reports, hidden, hidden_by FROM bb_posts WHERE id = 1`;
    assert.deepEqual(post, { reports: 6, hidden: true, hidden_by: "auto" });
    assert.equal(Number((await sql`SELECT count(*) AS n FROM bb_post_reports WHERE post_id = 1`)[0].n), 6);
    beforeVerification = null;
    assert.deepEqual(await reportPost(await reportPayload(reporters[0])), { ok: true, hidden: true });
    assert.equal(Number((await sql`SELECT reports FROM bb_posts WHERE id = 1`)[0].reports), 6, "another signature from one reporter is not another report");
  });
  await t.test("report insertion and counting wait behind the post lock", async () => {
    await clear(1);
    const reporters = await Promise.all([reporter(), reporter()]);
    const inputs = await Promise.all(reporters.map((signer) => reportPayload(signer)));
    barrier(2);
    const locker = await sql.reserve();
    let locked = false;
    let pending: Promise<Awaited<ReturnType<typeof reportPost>>[]> | undefined;
    try {
      await locker`BEGIN`;
      locked = true;
      // Allows report INSERT's FK key-share lock, but blocks its post UPDATE. Old code
      // inserts/counts before waiting here; correct code serializes before both operations.
      await locker`SELECT id FROM bb_posts WHERE id = 1 FOR NO KEY UPDATE`;
      pending = Promise.all(inputs.map(reportPost));
      const deadline = Date.now() + 5_000;
      for (;;) {
        const [state] = await root`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE application_name = ${schema} AND wait_event_type = 'Lock'`;
        if (state.waiting >= 2) break;
        assert.ok(Date.now() < deadline, "both real report transactions must be waiting on the post lock");
        await delay(10);
      }
      assert.equal(Number((await sql`SELECT count(*) AS n FROM bb_post_reports WHERE post_id = 1`)[0].n), 0,
        "waiting reporters must not insert or take a stale count before acquiring the post lock");
      await locker`COMMIT`;
      locked = false;
      assert.ok((await pending).every((r) => r.ok));
      const [post] = await sql`SELECT reports, hidden FROM bb_posts WHERE id = 1`;
      assert.deepEqual(post, { reports: 2, hidden: false });
    } finally {
      if (locked) await locker`ROLLBACK`;
      locker.release();
      await pending?.catch(() => {});
    }
  });
  await t.test("reports preserve manual moderation and reject invalid or replayed signatures", async () => {
    await clear(1);
    const signer = await reporter();
    await sql`UPDATE bb_posts SET hidden = true, hidden_by = ${wallet} WHERE id = 1`;
    const input = await reportPayload(signer);
    const invalid = await reportPost({ ...input, signature: "0x1234" });
    assert.equal(invalid.ok ? 200 : invalid.status, 401);
    assert.equal(await nonceCount(), 0);
    assert.deepEqual(await reportPost(input), { ok: true, hidden: true });
    const replay = await reportPost(input);
    assert.equal(replay.ok ? 200 : replay.status, 401);
    const [post] = await sql`SELECT reports, hidden, hidden_by FROM bb_posts WHERE id = 1`;
    assert.deepEqual(post, { reports: 1, hidden: true, hidden_by: wallet });
  });
});
