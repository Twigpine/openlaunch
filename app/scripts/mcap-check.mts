/** Actual read-model/API/SQL checks. Requires an empty, disposable localhost PostgreSQL database. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const url = process.env.MCAP_TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("Set MCAP_TEST_DATABASE_URL to an empty disposable database on 127.0.0.1");
process.env.DATABASE_URL = url;
process.env.BOOST = "off";
const stock = "0x000000000000000000000000000000000000a001";
const unlisted = "0x000000000000000000000000000000000000a002";
const savedFetch = globalThis.fetch;
// Deterministic quote feeds; the database and production query are real.
globalThis.fetch = async (input) => {
  const u = String(input);
  if (u.includes("coinbase.com")) return Response.json({ data: { amount: "2500" } });
  if (u.includes("/rhj/assets")) return Response.json([{ tokenSymbol: "TEST", tokenName: "Test stock", tokenDecimals: 6, currentMultiplier: "1", status: "ASSET_STATUS_ACTIVE", deployments: [{ contractAddress: stock, chainId: 4663 }] }]);
  if (u.includes("/rhj/prices/")) return Response.json({ quotes: [{ tokenSymbol: "TEST", bid: "200", ask: "200" }] });
  throw new Error(`Unexpected fetch in market-cap test: ${u}`);
};
const [{ db }, { publicClient }, { listLaunchesPage, getLaunch }, { startTickForFdv }, { classifyMcap, MCAP_POLICY_VERSION }, { clearMemo }, { mcapPageQuery }, { coreQuotes, quotesWithKey }, { PAIR_TWAP_WINDOW_S }] = await Promise.all([
  import("../src/lib/db"), import("../src/lib/chain"), import("../src/lib/launchpad/queries"), import("../src/lib/launchpad/math"), import("../src/lib/launchpad/mcap-policy"), import("../src/lib/launchpad/memo"), import("../src/lib/launchpad/mcap-query"), import("../src/lib/launchpad/config"), import("../src/lib/launchpad/pairs"),
]);
// One six-decimal community pair has a deterministic $2 spot and oracle history; every other RPC read is refused.
publicClient("base").readContract = (async (args: { address: string; functionName: string }) => {
  if (args.address === wallet(50_000) && args.functionName === "slot0") return [BigInt(Math.floor(Math.sqrt(2) * 2 ** 96)), 6931];
  if (args.address === wallet(50_000) && args.functionName === "observe") return [[0n, 6931n * BigInt(PAIR_TWAP_WINDOW_S)], []];
  throw new Error("No on-chain price feed in this test");
}) as ReturnType<typeof publicClient>["readContract"];
const sql = db();
const creator = `0x${"c".repeat(40)}`;
/** Derive a deterministic address so fixtures can reuse a wallet or deliberately use distinct wallets. */
const wallet = (id: number) => `0x${id.toString(16).padStart(40, "0")}`;
let seq = 0;
const launches = new Map<string, { token: string; chain: number; decimals: number; quoteUsd: number; block: number }>();
/** Insert a launch with configurable FDVs and quote units, retaining its identity for subsequent swap fixtures. */
async function launch(name: string, args: { chain?: number; quote?: string; decimals?: number; quoteUsd?: number; start?: number; current?: number; time?: string; sqrt?: boolean } = {}) {
  const id = ++seq, chain = args.chain ?? 5042, decimals = args.decimals ?? 6, quoteUsd = args.quoteUsd ?? 1;
  const start = args.start ?? 25_000, current = args.current ?? start;
  const rawRatio = 1e9 / (current / quoteUsd) * 10 ** (18 - decimals);
  const sqrt = BigInt(Math.floor(Math.sqrt(rawRatio) * 2 ** 96)).toString();
  const row = { token: wallet(1000 + id), chain, decimals, quoteUsd, block: 100 };
  await sql`INSERT INTO bb_launches (chain_id,token,token_id,launcher,quote,pool_id,start_tick,lp_fee,supply,name,symbol,block_number,block_time,tx_hash,log_index,sqrt_price_x96,tick)
    VALUES (${chain},${row.token},${id},${creator},${args.quote ?? "0x3600000000000000000000000000000000000000"},${`0x${id.toString(16).padStart(64,"0")}`},${startTickForFdv(start / quoteUsd, decimals)},0,'1000000000000000000000000000',${name},${name.slice(0,8)},100,${args.time ?? "2026-01-01T00:00:00Z"},${`0x${id.toString(16).padStart(64,"0")}`},0,${args.sqrt === false ? null : sqrt},${Math.floor(Math.log(rawRatio)/Math.log(1.0001))})`;
  launches.set(name, row);
}
/** Record a USD-sized swap in the launch's raw quote units and update its indexed lifetime volume. */
async function swap(name: string, dollars: number, who: string | null, block = 104) {
  const row = launches.get(name)!;
  const amount = BigInt(Math.round(dollars / row.quoteUsd * 10 ** row.decimals));
  const id = ++seq;
  await sql`INSERT INTO bb_launch_swaps (chain_id,tx_hash,log_index,token,pool_id,trader,amount0,amount1,sqrt_price_x96,tick,is_buy,block_number,block_time)
    SELECT chain_id,${`0x${(10000+id).toString(16).padStart(64,"0")}`},0,token,pool_id,${who},${(-amount).toString()},1,COALESCE(sqrt_price_x96,1),COALESCE(tick,start_tick),true,${block},'2026-02-01T00:00:00Z' FROM bb_launches WHERE chain_id=${row.chain} AND token=${row.token}`;
  await sql`UPDATE bb_launches SET volume_quote=volume_quote+${amount.toString()}::numeric,buys=buys+1 WHERE chain_id=${row.chain} AND token=${row.token}`;
}
/** Fetch the real read model using deterministic market-cap defaults, with overrides for individual checks. */
const page = (opts: Parameters<typeof listLaunchesPage>[0] = {}) => listLaunchesPage({ sort: "mcap", limit: 200, ethUsd: 2500, ...opts });
/** Extract names in result order to compare filtering and pagination against the same fixture identities. */
const names = (p: Awaited<ReturnType<typeof page>>) => p.items.map((r) => r.name);
try {
  const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  await sql.begin((tx) => tx.unsafe(schema));
  assert.equal((await sql`SELECT count(*) AS n FROM bb_launches`)[0].n, 0n, "use an empty test database");
  assert.throws(() => mcapPageQuery(sql, { where: sql``, quoteDecimals: sql`6`, quoteUsd: sql`1`, mode: "filtered", limit: 40, offset: 0, select: "SELECT * FROM bb_launches l" }), /unexpected SELECT prefix/, "a changed hydration SELECT must not silently drop market-cap facts");
  await launch("ArcMOON", { start: 1e35 }); await swap("ArcMOON", 0.02, creator);
  await launch("DOTTIE", { chain: 4663, quote: wallet(0), decimals: 18, quoteUsd: 2500, start: 5000, current: 25_700 });
  await launch("Small zero-volume", { start: 5000 });
  await launch("Grew from small", { start: 25_000, current: 50_000_000 });
  await launch("Fell to small", { start: 50_000_000, current: 25_000 });
  for (const name of ["Supported", "Cumulative wallet", "Creator only", "Snipers", "Two wallets", "Dust third", "Unknown trader"]) await launch(name, { start: 20_000_000 });
  for (const id of [1,2,3]) {
    await swap("Supported", 10_000, wallet(id));
    await swap("Creator only", 100_000, creator);
    await swap("Snipers", 10_000, wallet(id), 103);
  }
  await swap("Two wallets", 100_000, wallet(1)); await swap("Two wallets", 1, wallet(2));
  await swap("Cumulative wallet", 100_000, wallet(1)); await swap("Cumulative wallet", 1, wallet(2));
  await swap("Cumulative wallet", 0.6, wallet(3)); await swap("Cumulative wallet", 0.4, wallet(3));
  await swap("Dust third", 100_000, wallet(1)); await swap("Dust third", 1, wallet(2)); await swap("Dust third", 0.99, wallet(3));
  await swap("Unknown trader", 100_000, null);
  await launch("Stock six decimals", { chain: 4663, quote: stock, quoteUsd: 200, start: 12_345 });
  await launch("Stock wrong chain", { quote: stock, start: 12_345 });
  await launch("Unlisted six decimals", { quote: unlisted, start: 12_345 });
  await sql`INSERT INTO bb_quote_tokens (chain_id,address,decimals,symbol,name) VALUES (5042,${unlisted},6,'MEME','Unlisted')`;
  await launch("Arc native", { quote: wallet(0), decimals: 18, start: 10_000 });
  await launch("Older higher sqrt", { current: 20_000.0002 });
  await launch("Newer lower sqrt", { current: 20_000.0001, time: "2026-01-02T00:00:00Z" });
  await launch("Tie A", { current: 12_000 }); await launch("Tie B", { current: 12_000 });
  await launch("No swaps fallback", { start: 8000, sqrt: false });
  const baseUsdc = coreQuotes("base").find((q) => q.key === "usdc")!;
  const weth = quotesWithKey("eth").find((q) => q.chain === "base" && q.address !== wallet(0))!;
  await launch("Wrapped ETH", { chain: 8453, quote: weth.address, decimals: 18, quoteUsd: 2500, start: 34_567 });
  for (const [id, symbol, status] of [[40_000, "PAIRTEST", "listed"], [40_001, "PAIRNULL", "listed"], [40_002, "PAIRHALT", "suspended"]] as const) {
    await sql`INSERT INTO bb_pairs (chain_id,address,symbol,name,decimals,status,price_kind,price_pool,price_quote)
      VALUES (8453,${wallet(id)},${symbol},${symbol},6,${status},'univ3',${wallet(id + 10_000)},${baseUsdc.address})`;
  }
  await launch("Pair six decimals", { chain: 8453, quote: wallet(40_000), decimals: 6, quoteUsd: 2, start: 15_000 });
  await launch("Pair no price", { chain: 8453, quote: wallet(40_001), start: 15_000 });
  await launch("Suspended pair", { chain: 8453, quote: wallet(40_002), start: 15_000 });
  await launch("Pair wrong chain", { quote: wallet(40_000), start: 15_000 });

  const all = await page({ mcap: "all" });
  const filtered = await page();
  const hidden = ["ArcMOON", "Creator only", "Snipers", "Two wallets", "Dust third", "Unknown trader"];
  assert.deepEqual(names(filtered), names(all).filter((name) => !hidden.includes(name)));
  for (const name of ["DOTTIE", "Small zero-volume", "Supported", "Grew from small", "Fell to small"]) assert.ok(names(filtered).includes(name), name);
  assert.equal(all.items.find((r) => r.name === "Supported")!.traders_24h_ex, 0, "quiet lifetime history still qualifies");
  for (const row of all.items) assert.equal(row.mcap!.classification, classifyMcap(row.mcap!), "SQL and policy agree");
  assert.equal(all.items.find((r) => r.name === "Dust third")!.mcap!.outsideTraders, 2);
  assert.equal(all.items.find((r) => r.name === "Cumulative wallet")!.mcap!.outsideTraders, 3, "wallet minimum is cumulative, not per trade");
  assert.equal(all.items.find((r) => r.name === "Small zero-volume")!.mcap!.outsideVolumeQuote, null, "unassessed is not zero activity");
  const priced = filtered.items.filter((r) => r.fdv_usd !== null);
  for (let i=1;i<priced.length;i++) assert.ok(priced[i-1].fdv_usd! >= priced[i].fdv_usd!, "displayed USD valuations descend");
  assert.ok(names(all).indexOf("Older higher sqrt") < names(all).indexOf("Newer lower sqrt"), "sqrt price beats a same-tick age tie");
  assert.ok(names(all).indexOf("Tie A") < names(all).indexOf("Tie B"), "token breaks exact ties");
  const unknown = all.items.filter((r) => r.fdv_usd === null);
  assert.deepEqual(new Set(unknown.map((r) => r.name)), new Set(["Stock wrong chain", "Unlisted six decimals", "Pair no price", "Suspended pair", "Pair wrong chain"]));
  assert.deepEqual(all.items.slice(-unknown.length), unknown, "unknown USD valuations sort last");
  assert.equal(all.items.find((r) => r.name === "Unlisted six decimals")!.quote_decimals, 6);
  assert.ok(Math.abs(all.items.find((r) => r.name === "Stock six decimals")!.fdv_usd! - 12_345) < 1e-7);
  assert.ok(Math.abs(all.items.find((r) => r.name === "Arc native")!.fdv_usd! - 10_000) < 1e-7);
  assert.ok(Math.abs(all.items.find((r) => r.name === "Wrapped ETH")!.fdv_usd! - 34_567) < 1e-7, "wrapped ETH keeps its USD price");
  const pairRow = all.items.find((r) => r.name === "Pair six decimals")!;
  assert.equal(pairRow.quote_key, "pair"); assert.equal(pairRow.quote_decimals, 6);
  assert.ok(Math.abs(pairRow.fdv_usd! - 15_000) < 1e-7, "community pair USD ordering and display use the same units");
  assert.equal(all.items.find((r) => r.name === "Pair no price")!.quote_key, "pair");
  for (const name of ["Suspended pair", "Pair wrong chain"]) assert.equal(all.items.find((r) => r.name === name)!.quote_key, "other");
  assert.ok(all.items.find((r) => r.name === "No swaps fallback")!.fdv_usd! > 8000);
  const paged = [];
  for (let offset=0;offset<filtered.items.length;offset+=2) {
    const p = await page({ limit: 2, offset }); paged.push(...p.items.map((r)=>r.token));
    assert.equal(p.hasMore, offset + 2 < filtered.items.length);
  }
  assert.deepEqual(paged, filtered.items.map((r)=>r.token), "filtering precedes pagination without gaps or duplicates");
  assert.ok((await page({ chain: "arc" })).items.every((r)=>r.chain==="arc"));
  assert.ok((await page({ filter: "usdc" })).items.every((r)=>r.quote_key==="usdc"));
  assert.equal((await page({ filter: "today" })).items.length, 0);
  assert.ok(names(await page({ sort: "new" })).includes("ArcMOON"), "other sorts retain outliers");
  assert.ok(await getLaunch("arc", launches.get("ArcMOON")!.token, 2500), "direct links retain outliers");
  const [normal, doubled, missing] = await Promise.all([page(),page({ethUsd:5000}),page({ethUsd:null})]);
  assert.equal(normal.items.find((r)=>r.name==="DOTTIE")!.quote_usd,2500);
  assert.equal(doubled.items.find((r)=>r.name==="DOTTIE")!.quote_usd,5000);
  assert.equal(missing.items.find((r)=>r.name==="DOTTIE")!.fdv_usd,null, "no ETH=$1 fallback");

  const { GET } = await import("../src/app/api/launch/list/route");
  const launcherResponse = await GET(new Request(`http://localhost/api/launch/list?sort=mcap&launcher=${wallet(999_999)}`));
  assert.equal(launcherResponse.status, 200);
  assert.deepEqual((await launcherResponse.json()).launches, [], "market-cap mode preserves launcher scoping");
  const defaultResponse = await GET(new Request("http://localhost/api/launch/list?sort=mcap&limit=200"));
  assert.equal(defaultResponse.status, 200);
  const defaultData = await defaultResponse.json();
  assert.equal(defaultData.mcap, "filtered");
  assert.deepEqual(defaultData.launches.map((r: { name: string }) => r.name), names(filtered));
  for (const mode of ["filtered","all"] as const) {
    const response=await GET(new Request(`http://localhost/api/launch/list?sort=mcap&mcap=${mode}&limit=200`));
    assert.equal(response.status,200); const data=await response.json();
    assert.equal(data.mcap,mode); assert.equal(data.mcap_policy,MCAP_POLICY_VERSION);
    assert.deepEqual(data.launches.map((r:{name:string})=>r.name),names(mode==="all"?all:filtered));
  }
  clearMemo();
  const { GET: live } = await import("../src/app/api/launch/live/route");
  for (const mode of ["all","filtered"] as const) {
    const response=await live(new Request(`http://localhost/api/launch/live?sort=mcap&mcap=${mode}&limit=200&boost=1`));
    assert.equal(response.status,200); const data=await response.json();
    assert.equal(data.mcap,mode);
    assert.equal(data.boost_on, false, "Boost metadata survives alongside market-cap mode");
    assert.deepEqual(data.launches.map((r:{name:string})=>r.name),names(mode==="all"?all:filtered),"live cache keys isolate modes");
  }
  const before=performance.now(); await page();
  console.log(`market-cap: actual SQL, classification, lifetime history, decimal/chain pricing, sqrt ordering, pagination, concurrent requests and list/live APIs passed (${(performance.now()-before).toFixed(1)}ms warm list, ${all.items.length} fixtures)`);
} finally {
  globalThis.fetch=savedFetch;
  await sql.end();
}
