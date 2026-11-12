import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getMock, maybeDb, resetMock } from "@/lib/db-mock";
import { resetEthPriceCache } from "@/lib/launchpad/ethPrice";
import { computeSeason, indexSnapshotReady, invalidatedSeason, sameIndexSnapshot, type IndexSnapshot, type Season } from "./server";

const row = (generation = 0n): IndexSnapshot[number] => ({ chain_id: 8453, reorg_generation: generation, reorg_version: 1, rebuilding_until: null });

test("points refuse unvalidated, rebuilding or missing required chains", () => {
  assert.equal(indexSnapshotReady([row()], [8453]), true);
  assert.equal(indexSnapshotReady([{ ...row(), reorg_version: 0 }], [8453]), false);
  assert.equal(indexSnapshotReady([{ ...row(), reorg_version: 2 }], [8453]), false);
  assert.equal(indexSnapshotReady([{ ...row(), rebuilding_until: 200n }], [8453]), false);
  assert.equal(indexSnapshotReady([row()], [8453, 5042002]), false);
});

test("points compare the generation, not whether a replay regained its old height", () => {
  assert.equal(sameIndexSnapshot([row()], [row()]), true);
  assert.equal(sameIndexSnapshot([row()], [row(1n)]), false);
  assert.equal(sameIndexSnapshot([row()], []), false);
  assert.equal(sameIndexSnapshot([row()], [row(), { ...row(), chain_id: 5042002 }]), false);
});

function fixture(t: TestContext, current: IndexSnapshot) {
  resetMock();
  resetEthPriceCache();
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url).includes("api.coinbase.com/v2/prices/ETH-USD/spot")) return new Response(JSON.stringify({ data: { amount: "2500" } }));
    throw new Error("offline points test");
  });
  t.mock.method(console, "warn", () => {});
  const now = Date.now();
  const season: Season = { id: 7, slug: "s7", name: "Seven", starts_at: new Date(now - 86400000).toISOString(), ends_at: new Date(now + 86400000).toISOString(), public: true, computed_at: null, computed_until: null, published_at: new Date(now - 86400000).toISOString(), rules_version: 1 };
  const queries: string[] = [];
  getMock().query = async (sql) => {
    queries.push(sql);
    if (sql.includes("reorg_generation")) return sql.includes("FOR UPDATE") ? current : [row()];
    if (sql.includes("FROM bb_seasons") && sql.includes("FOR UPDATE")) return [season];
    return [];
  };
  return { season, queries, db: maybeDb()! };
}

test("a reorg during scoring prevents point deletion/publication after the cursor locks", async (t) => {
  const f = fixture(t, [row(1n)]);
  const result = await computeSeason(f.db, f.db, f.season);
  assert.deepEqual(result, { skipped: "the season or canonical index changed while it was being computed" });
  assert.ok(f.queries.some((q) => q.includes("bb_launch_sync_cursor ORDER BY chain_id FOR UPDATE")));
  assert.equal(f.queries.some((q) => q.includes("DELETE FROM bb_points")), false);
  assert.equal(f.queries.some((q) => q.includes("FROM bb_seasons") && q.includes("FOR UPDATE")), false);
});

test("unchanged generation publishes after cursor locks then season lock and clears dirty state", async (t) => {
  const f = fixture(t, [row()]);
  const result = await computeSeason(f.db, f.db, f.season);
  assert.equal("wallets" in result && result.wallets, 0);
  const chainLock = f.queries.findIndex((q) => q.includes("bb_launch_sync_cursor ORDER BY chain_id FOR UPDATE"));
  const seasonLock = f.queries.findIndex((q) => q.includes("FROM bb_seasons") && q.includes("FOR UPDATE"));
  const deletion = f.queries.findIndex((q) => q.includes("DELETE FROM bb_points"));
  assert.ok(chainLock >= 0 && seasonLock > chainLock && deletion > seasonLock);
  assert.ok(f.queries.some((q) => q.includes("reorg_invalidated_at = NULL")));
});

test("historical invalidated seasons are selected independently of the latest season", async () => {
  resetMock();
  const historical = { id: 2, reorg_invalidated_at: "2026-11-12T00:00:00Z", rules_version: 1 };
  getMock().query = async (sql) => {
    assert.match(sql, /reorg_invalidated_at IS NOT NULL/);
    assert.match(sql, /ORDER BY starts_at, id LIMIT 1/);
    return [historical];
  };
  assert.deepEqual(await invalidatedSeason(), historical);
});
