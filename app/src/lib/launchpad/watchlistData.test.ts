import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { WatchlistData, WatchlistRequestItem } from "./watchlistData";
import { CHAIN_IDS, isChainKey, type ChainKey } from "../chainKeys.ts";

const source = readFileSync(new URL("./watchlistData.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../../app/api/launch/watchlist/route.ts", import.meta.url), "utf8");
const queries = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
const NOW = 1_800_000_000_000;
const TOKEN = `0x${"ab".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;

function compile(source: string, imports: Record<string, unknown>, date = Date) {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exported: Record<string, unknown> = {};
  new Function("require", "exports", "Date", output)((id: string) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected import: ${id}`);
    return imports[id];
  }, exported, date);
  return exported;
}

function isolatedData(configured = true) {
  const calls = { launch: [] as unknown[][], sql: [] as { sql: string; values: unknown[] }[] };
  const launches = [
    { launch: { chain: "base", token: TOKEN, name: "Base token" }, holders: 0 },
    { launch: { chain: "robinhood", token: TOKEN, name: "Robinhood token" }, holders: null },
    { launch: { chain: "arc", token: TOKEN, name: "Arc token" }, holders: 4 },
  ];
  const counts = [
    { chain_id: 8453, token: TOKEN, trades: "0", creator_posts: "2" },
    { chain_id: 4663, token: TOKEN, trades: "8", creator_posts: "0" },
    { chain_id: 5042, token: TOKEN, trades: "3", creator_posts: "1" },
  ];
  const db = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.sql.push({ sql: parts.join("?"), values });
    return counts;
  }, { json: (value: unknown) => value });
  const imported = compile(source, {
    "server-only": {},
    "@/lib/db": { maybeDb: () => configured ? db : null },
    "@/lib/chainPublic": { chainIdOf: (chain: ChainKey) => CHAIN_IDS[chain], isChainKey },
    "./queries": { getLaunchesByRefs: async (...args: unknown[]) => { calls.launch.push(args); return launches; } },
  });
  const api = imported as unknown as {
    WATCHLIST_BODY_MAX_BYTES: number;
    WATCHLIST_WINDOW_MS: number;
    WatchlistInputError: new (message: string, status?: number) => Error & { status: number };
    parseWatchlistRequest: (value: unknown, at: number) => WatchlistRequestItem[];
    readWatchlistBody: (req: Request) => Promise<unknown>;
    getWatchlistData: (items: WatchlistRequestItem[], at: number, usd: number | null) => Promise<WatchlistData>;
  };
  return { ...api, calls, launches, counts };
}

test("watchlist input normalizes addresses, deduplicates within a chain, and preserves cross-chain identity", () => {
  const { parseWatchlistRequest } = isolatedData();
  assert.deepEqual(parseWatchlistRequest({ items: [
    { chain: "base", token: TOKEN.toUpperCase(), since: NOW - 1 },
    { chain: "base", token: TOKEN, since: NOW - 50 },
    { chain: "robinhood", token: TOKEN },
  ] }, NOW), [
    { chain: "base", token: TOKEN, since: NOW - 1 },
    { chain: "robinhood", token: TOKEN, since: null },
  ]);
});

test("Arc snapshots use their own chain ID and do not inherit another chain's activity", async () => {
  const { getWatchlistData, calls } = isolatedData();
  const items: WatchlistRequestItem[] = [{ chain: "arc", token: TOKEN, since: NOW - 500 }];
  const response = await getWatchlistData(items, NOW, 3_000);
  assert.equal(response.items[0].launch?.chain, "arc");
  assert.equal(response.items[0].holders, 4);
  assert.equal(response.items[0].trades, 3);
  assert.equal(response.items[0].creatorPosts, 1);
  assert.deepEqual(calls.launch, [[items, 3_000]]);
  assert.deepEqual(calls.sql[0].values, [[{ chain_id: 5042, token: TOKEN, since: new Date(NOW - 500).toISOString() }], NOW / 1_000, NOW / 1_000]);
});

test("watchlist rejects malformed, oversized, and future-dated input before reads", async () => {
  const { parseWatchlistRequest, getWatchlistData, calls } = isolatedData();
  for (const body of [null, [], {}, { items: "no" }, { items: [null] }, { items: [{ chain: "ethereum", token: TOKEN }] }, { items: [{ chain: "base", token: "0x123" }] }]) {
    assert.throws(() => parseWatchlistRequest(body, NOW));
  }
  for (const since of [NaN, Infinity, -Infinity, -1, 3.1, "1800000000", NOW + 300_001, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseWatchlistRequest({ items: [{ chain: "base", token: TOKEN, since }] }, NOW));
  }
  const ref = { chain: "base" as const, token: TOKEN, since: null };
  assert.equal(parseWatchlistRequest({ items: Array(50).fill(ref) }, NOW).length, 1);
  assert.throws(() => parseWatchlistRequest({ items: Array(51).fill(ref) }, NOW));
  await assert.rejects(getWatchlistData([{ ...ref, since: NOW + 300_001 }], NOW, null));
  assert.deepEqual(calls, { launch: [], sql: [] });
});

test("small device clock skew clamps to the server cutoff without creating a future window", async () => {
  const { parseWatchlistRequest, getWatchlistData, calls } = isolatedData();
  for (const since of [NOW + 1, NOW + 300_000]) {
    assert.deepEqual(parseWatchlistRequest({ items: [{ chain: "base", token: TOKEN, since }] }, NOW), [{ chain: "base", token: TOKEN, since: NOW }]);
  }
  const data = await getWatchlistData([{ chain: "base", token: TOKEN, since: NOW + 300_000 }], NOW, null);
  assert.equal(data.items[0].since, NOW);
  assert.equal(data.items[0].windowClamped, false);
  assert.deepEqual(calls.sql[0].values, [[{ chain_id: 8453, token: TOKEN, since: new Date(NOW).toISOString() }], NOW / 1_000, NOW / 1_000]);
});

test("watchlist body reads enforce byte limits without trusting Content-Length", async () => {
  const { readWatchlistBody, WATCHLIST_BODY_MAX_BYTES } = isolatedData();
  const request = (body: string, extra: Record<string, string> = {}) => new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json", ...extra }, body });
  assert.deepEqual(await readWatchlistBody(request('{"items":[]}')), { items: [] });
  await assert.rejects(readWatchlistBody(request("{}", { "content-length": String(WATCHLIST_BODY_MAX_BYTES + 1) })), { status: 413 });
  await assert.rejects(readWatchlistBody(request(JSON.stringify({ text: "界".repeat(6_000) }), { "content-length": "1" })), { status: 413 });
  await assert.rejects(readWatchlistBody(request("not-json")), { status: 400 });
  await assert.rejects(readWatchlistBody(request("{}", { "content-type": "text/plain" })), { status: 415 });
  const bytes = new TextEncoder().encode('{"items":[]}');
  const streamed = new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, duplex: "half", body: new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 5)); controller.enqueue(bytes.slice(5)); controller.close(); } }) } as RequestInit);
  assert.deepEqual(await readWatchlistBody(streamed), { items: [] });
});

test("unconfigured indexes and unknown launches never masquerade as zero activity", async () => {
  const ref = { chain: "base" as const, token: TOKEN, since: NOW - 1_000 };
  const unavailable = isolatedData(false);
  const response = await unavailable.getWatchlistData([ref], NOW, null);
  assert.equal(response.indexed, false);
  assert.deepEqual(response.items[0], { ...ref, windowClamped: false, launch: null, holders: null, trades: null, creatorPosts: null });
  assert.deepEqual(unavailable.calls, { launch: [], sql: [] });
  const { getWatchlistData } = isolatedData();
  const missing = await getWatchlistData([{ ...ref, token: OTHER }], NOW, null);
  assert.equal(missing.items[0].launch, null);
  assert.equal(missing.items[0].holders, null);
  assert.equal(missing.items[0].trades, null);
  assert.equal(missing.items[0].creatorPosts, null);
});

test("batch snapshots retain request order, exact zero counts, first-visit nulls, and one cutoff", async () => {
  const { getWatchlistData, calls } = isolatedData();
  const items: WatchlistRequestItem[] = [
    { chain: "robinhood", token: TOKEN, since: NOW - 500 },
    { chain: "base", token: TOKEN, since: NOW - 1_000 },
    { chain: "base", token: OTHER, since: null },
  ];
  const response = await getWatchlistData(items, NOW, 3_000);
  assert.equal(response.at, NOW);
  assert.equal(response.indexed, true);
  assert.deepEqual(response.items.map(({ chain, token, trades, creatorPosts, holders }) => ({ chain, token, trades, creatorPosts, holders })), [
    { chain: "robinhood", token: TOKEN, trades: 8, creatorPosts: 0, holders: null },
    { chain: "base", token: TOKEN, trades: 0, creatorPosts: 2, holders: 0 },
    { chain: "base", token: OTHER, trades: null, creatorPosts: null, holders: null },
  ]);
  assert.deepEqual(calls.launch, [[items, 3_000]]);
  assert.equal(calls.sql.length, 1);
  assert.deepEqual(calls.sql[0].values, [[
    { chain_id: 4663, token: TOKEN, since: new Date(NOW - 500).toISOString() },
    { chain_id: 8453, token: TOKEN, since: new Date(NOW - 1_000).toISOString() },
  ], NOW / 1_000, NOW / 1_000]);
  assert.match(calls.sql[0].sql, /s\.chain_id = w\.chain_id AND s\.token = w\.token/);
  assert.match(calls.sql[0].sql, /s\.block_time > w\.since AND s\.block_time <= to_timestamp\(\?\)/);
  assert.match(calls.sql[0].sql, /p\.chain_id = w\.chain_id AND p\.token = w\.token AND p\.wallet = l\.launcher/);
  assert.match(calls.sql[0].sql, /NOT p\.hidden AND p\.parent_id IS NULL/);
  assert.match(calls.sql[0].sql, /p\.created_at > w\.since AND p\.created_at <= to_timestamp\(\?\)/);
  assert.doesNotMatch(calls.sql[0].sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
});

test("old catchup windows are explicitly clamped to 30 days and first visits skip activity scans", async () => {
  const { getWatchlistData, calls, WATCHLIST_WINDOW_MS } = isolatedData();
  const old = await getWatchlistData([{ chain: "base", token: TOKEN, since: 0 }], NOW, null);
  assert.equal(old.items[0].windowClamped, true);
  assert.equal(old.items[0].since, NOW - WATCHLIST_WINDOW_MS);
  const fresh = await getWatchlistData([{ chain: "base", token: TOKEN, since: null }], NOW, null);
  assert.equal(fresh.items[0].launch?.token, TOKEN);
  assert.equal(fresh.items[0].holders, 0);
  assert.equal(fresh.items[0].trades, null);
  assert.equal(fresh.items[0].creatorPosts, null);
  assert.equal(calls.sql.length, 1);
  assert.deepEqual(await getWatchlistData([], NOW, null), { at: NOW, indexed: true, items: [] });
  assert.equal(calls.launch.length, 2);
});

function isolatedRoute(opts: { configured?: boolean; limited?: boolean; fail?: boolean } = {}) {
  const data = isolatedData();
  let reads = 0;
  class SnapshotDate extends Date { static now() { return NOW; } }
  const exported = compile(route, {
    "next/server": { NextResponse: { json: (body: unknown, init: ResponseInit) => Response.json(body, init) } },
    "@/lib/db": { dbConfigured: () => opts.configured !== false },
    "@/lib/launchpad/editServer": { rateLimited: () => Boolean(opts.limited) },
    "@/lib/launchpad/ethPrice": { ethUsd: async () => { reads++; return null; } },
    "@/lib/launchpad/watchlistData": {
      ...data,
      getWatchlistData: async (...args: Parameters<typeof data.getWatchlistData>) => {
        if (opts.fail) throw new Error("private backend diagnostic");
        return data.getWatchlistData(...args);
      },
    },
  }, SnapshotDate) as unknown as { POST: (req: Request) => Promise<Response> };
  const request = (items: unknown) => new Request("https://example.test/api/launch/watchlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
  return { post: exported.POST, request, reads: () => reads };
}

test("watchlist route is uncached, uses server milliseconds, and avoids reads for bad input", async () => {
  const { post, request, reads } = isolatedRoute();
  const response = await post(request([{ chain: "base", token: TOKEN, since: NOW - 100 }]));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).at, NOW);
  const invalid = await post(request([{ chain: "base", token: TOKEN, since: NOW + 300_001 }]));
  assert.equal(invalid.status, 400);
  assert.equal(reads(), 1);
});

test("watchlist route has explicit retryable outages and rate limits without leaking errors", async () => {
  for (const opts of [{ configured: false }, { fail: true }]) {
    const { post, request } = isolatedRoute(opts);
    const response = await post(request([{ chain: "base", token: TOKEN, since: null }]));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.indexed, false);
    assert.doesNotMatch(body.error, /private backend diagnostic/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const { post, request, reads } = isolatedRoute({ limited: true });
  const response = await post(request([]));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(reads(), 0);
});

test("launch lookup reuses shaping in one bounded query and gates holder counts on complete backfill", async () => {
  const helper = queries.slice(queries.indexOf("export async function getLaunchesByRefs("), queries.indexOf("/** Find which chain"));
  const calls: { parts: string; values: unknown[] }[] = [];
  let warmed = 0;
  const raw = [
    { chain_id: 8453, token: TOKEN, block_number: 10n, holders_synced_block: null, holders: 6 },
    { chain_id: 4663, token: TOKEN, block_number: 10n, holders_synced_block: 1_000_010n, holders: 5 },
    { chain_id: 8453, token: OTHER, block_number: 10n, holders_synced_block: 2_000_011n, holders: 8 },
    { chain_id: 8453, token: OTHER, block_number: 10n, holders_synced_block: 9223372036854775807n, holders: 0 },
  ];
  const db = Object.assign((parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ parts: parts.join("?"), values });
    return parts.join("").includes("WHERE") ? Promise.resolve(raw) : { parts, values };
  }, { unsafe: (value: string) => value });
  const output = ts.transpileModule(helper, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exported = {} as { getLaunchesByRefs: (refs: { chain: string; token: string }[], usd?: number | null) => Promise<{ holders: number | null; launch: unknown }[]> };
  new Function("exports", "maybeDb", "withStocks", "chainIdOf", "shape", "SELECT", "SYNCED_FOREVER", output)(exported, () => db, async () => { warmed++; }, (chain: string) => chain === "base" ? 8453 : 4663, (row: unknown) => row, "SELECT l.* FROM bb_launches l", 9223372036854775807n);
  const ref = { chain: "base", token: TOKEN.toUpperCase() };
  assert.deepEqual(await exported.getLaunchesByRefs([]), []);
  await assert.rejects(exported.getLaunchesByRefs(Array(51).fill(ref)));
  assert.equal(warmed, 0);
  const result = await exported.getLaunchesByRefs([ref, { chain: "robinhood", token: TOKEN }]);
  assert.equal(warmed, 1);
  assert.deepEqual(result.map((item) => item.holders), [null, null, null, 0]);
  assert.equal(calls.filter((call) => call.parts.includes("WHERE")).length, 1);
  assert.deepEqual(calls[0].values, [8453, TOKEN]);
  assert.deepEqual(calls[1].values, [4663, TOKEN]);
});
