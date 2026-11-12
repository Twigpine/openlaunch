import assert from "node:assert/strict";
import test from "node:test";

// Opt-in: real PostgreSQL, actual indexer/SQL, synthetic canonical branches.
// No real RPC, wallets, transactions, environment files or external price calls.
// From app/: RUN_REORG_DB_TESTS=1 REORG_TEST_DATABASE_URL=postgres://...@127.0.0.1:PORT/audit
// npx tsx --conditions=react-server --tsconfig tsconfig.reorg-db-test.json --test src/lib/launchpad/indexer.reorg.db.test.ts
test("canonical event indexing and reorg recovery match a clean PostgreSQL rebuild", {
  skip: process.env.RUN_REORG_DB_TESTS !== "1", timeout: 120_000,
}, async (t) => {
  const endpoint = process.env.REORG_TEST_DATABASE_URL;
  assert.ok(endpoint, "REORG_TEST_DATABASE_URL is required for this opt-in test");
  const url = new URL(endpoint);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol)
    && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && url.port && !url.search && !url.hash,
  "reorg tests require an explicit loopback PostgreSQL host and port, without URL options");
  const settings = {
    NEXT_PUBLIC_LAUNCH_FACTORY: "0x1111111111111111111111111111111111111111",
    NEXT_PUBLIC_LAUNCH_LOCKER: "0x4444444444444444444444444444444444444444",
    LAUNCH_DEPLOY_BLOCK: "100",
    LAUNCH_SYNC_CONFIRMATIONS_BASE: "2",
  };
  const previous = new Map(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("External fetch disabled in reorg integration tests"); };
  t.after(() => {
    globalThis.fetch = fetchBefore;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { runReorgDbTests } = await import("../../../scripts/reorg-db-test-suite.ts");
  await runReorgDbTests(t, endpoint);
});
