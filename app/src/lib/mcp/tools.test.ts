import assert from "node:assert/strict";
import test from "node:test";
import { validateArgs } from "./schema.ts";
import { ToolError } from "./server.ts";
import { createMcpTools, type McpToolDeps } from "./tools.ts";

const TOKEN = "0x" + "a".repeat(40);
const LAUNCH = { chain: "base", token: TOKEN, quote_decimals: 18, symbol: "TEST" };

function tools(overrides: Record<string, unknown>) {
  return createMcpTools(overrides as unknown as Partial<McpToolDeps>);
}

async function run(all: ReturnType<typeof tools>, name: string, args: Record<string, unknown> = {}) {
  const tool = all.find((t) => t.name === name);
  assert.ok(tool, name);
  const checked = validateArgs(tool.inputSchema, args);
  assert.equal(checked.ok, true, checked.ok ? "" : checked.error);
  if (!checked.ok) throw new Error(checked.error);
  return tool.run(checked.value);
}

test("tool names are unique and every schema rejects unknown arguments", () => {
  const all = createMcpTools();
  const names = all.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.length >= 8);
  for (const tool of all) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.match(tool.description, /\S/);
    assert.equal(tool.annotations.readOnlyHint, true);
  }
});

test("list_launches passes defaults and the caller's options to the site's list model", async () => {
  let seen: Record<string, unknown> | null = null;
  const all = tools({
    ethUsd: async () => 2_500,
    listLaunchesPage: async (opts: Record<string, unknown>) => {
      seen = opts;
      return { items: [LAUNCH], hasMore: true };
    },
  });
  const result = (await run(all, "list_launches")) as { eth_usd: number; has_more: boolean; launches: unknown[] };
  assert.equal(result.eth_usd, 2_500);
  assert.equal(result.has_more, true);
  assert.equal(result.launches.length, 1);
  assert.deepEqual(seen, {
    sort: "live",
    window: "all",
    mcap: "all",
    filter: null,
    chain: null,
    launcher: undefined,
    limit: 10,
    offset: 0,
    ethUsd: 2_500,
  });

  await run(all, "list_launches", { chain: "arc", sort: "volume", window: "24h", filter: "burn", launcher: TOKEN, limit: 1, offset: 2 });
  assert.deepEqual(seen && (seen as Record<string, unknown>).chain, "arc");
  assert.deepEqual(seen && (seen as Record<string, unknown>).filter, "burn");
  assert.deepEqual(seen && (seen as Record<string, unknown>).limit, 1);
});

test("get_launch lowercases the address and reports a missing launch", async () => {
  let asked: unknown[] = [];
  const all = tools({
    ethUsd: async () => 3_000,
    getLaunch: async (...args: unknown[]) => {
      asked = args;
      return LAUNCH;
    },
  });
  const upper = "0x" + "A".repeat(40);
  const result = (await run(all, "get_launch", { chain: "base", token: upper })) as { launch: unknown };
  assert.deepEqual(asked, ["base", TOKEN, 3_000]);
  assert.equal(result.launch, LAUNCH);

  const missing = tools({ ethUsd: async () => null, getLaunch: async () => null });
  await assert.rejects(() => run(missing, "get_launch", { chain: "base", token: TOKEN }), (error: unknown) => error instanceof ToolError);
});

test("get_token_trades reads the launch first, for the quote's decimals", async () => {
  let swapArgs: unknown[] = [];
  const all = tools({
    getLaunch: async () => LAUNCH,
    getSwaps: async (...args: unknown[]) => {
      swapArgs = args;
      return [{ tx_hash: "0x1" }];
    },
  });
  const result = (await run(all, "get_token_trades", { chain: "base", token: TOKEN, limit: 5 })) as { trades: unknown[] };
  assert.deepEqual(swapArgs, ["base", TOKEN, 18, 5]);
  assert.equal(result.trades.length, 1);
});

test("get_token_holders returns the panel or a caller-correctable error", async () => {
  const panel = { holders: 12, top: [], synced: true };
  const all = tools({ getHolderPanel: async () => panel });
  assert.deepEqual(await run(all, "get_token_holders", { chain: "base", token: TOKEN }), { chain: "base", token: TOKEN, ...panel });

  const none = tools({ getHolderPanel: async () => null });
  await assert.rejects(() => run(none, "get_token_holders", { chain: "base", token: TOKEN }), ToolError);
});

test("search_launches and get_recent_activity pass the price through", async () => {
  let searchOpts: Record<string, unknown> | null = null;
  let feedArgs: unknown[] = [];
  const all = tools({
    ethUsd: async () => 1_900,
    searchLaunches: async (_q: string, opts: Record<string, unknown>) => {
      searchOpts = opts;
      return [LAUNCH];
    },
    getLaunchFeed: async (...args: unknown[]) => {
      feedArgs = args;
      return [{ kind: "swap" }];
    },
  });
  const search = (await run(all, "search_launches", { query: "test", chain: "base", order: "holders", limit: 3 })) as { launches: unknown[] };
  assert.deepEqual(searchOpts, { chain: "base", limit: 3, ethUsd: 1_900, order: "holders" });
  assert.equal(search.launches.length, 1);

  const feed = (await run(all, "get_recent_activity", { limit: 7 })) as { activity: unknown[] };
  assert.deepEqual(feedArgs, [7, 1_900]);
  assert.equal(feed.activity.length, 1);
});

test("list_posts requires chain and token only for the token scope", async () => {
  let feedArgs: unknown[] = [];
  let tokenArgs: unknown[] = [];
  const all = tools({
    listFeed: async (...args: unknown[]) => {
      feedArgs = args;
      return [{ id: 1 }];
    },
    listTokenPosts: async (...args: unknown[]) => {
      tokenArgs = args;
      return { posts: [{ id: 2 }], muted: false, nextCursor: 1 };
    },
  });
  const feed = (await run(all, "list_posts", { scope: "feed", limit: 5 })) as { posts: unknown[] };
  assert.deepEqual(feedArgs, [5, 0]);
  assert.equal(feed.posts.length, 1);

  const token = (await run(all, "list_posts", { scope: "token", chain: "base", token: TOKEN, limit: 5, before_id: 9 })) as { posts: unknown[] };
  assert.deepEqual(tokenArgs, ["base", TOKEN, 5, 9]);
  assert.equal(token.posts.length, 1);

  await assert.rejects(() => run(all, "list_posts", { scope: "token" }), ToolError);
});

test("list_community_pairs shows listed pairs only and filters by chain", async () => {
  const all = tools({
    loadPairs: async () => [
      { chain: "base", status: "listed", symbol: "A" },
      { chain: "base", status: "suspended", symbol: "B" },
      { chain: "arc", status: "listed", symbol: "C" },
    ],
  });
  const base = (await run(all, "list_community_pairs", { chain: "base" })) as { count: number; pairs: Array<{ symbol: string }> };
  assert.equal(base.count, 1);
  assert.equal(base.pairs[0].symbol, "A");

  const every = (await run(all, "list_community_pairs")) as { count: number };
  assert.equal(every.count, 2);
});

test("get_points_leaderboard handles no public season and a live board", async () => {
  const none = tools({ publicSeason: async () => null });
  assert.deepEqual(await run(none, "get_points_leaderboard"), { season: null, board: "creator", rows: [], names: {} });

  const season = { id: 7, slug: "s1" };
  let boardArgs: unknown[] = [];
  const all = tools({
    publicSeason: async () => season,
    boardRows: async (...args: unknown[]) => {
      boardArgs = args;
      return { rows: [{ rank: 1 }], names: { "0x1": "alice" } };
    },
  });
  assert.deepEqual(await run(all, "get_points_leaderboard", { board: "scout", limit: 2 }), {
    season,
    board: "scout",
    rows: [{ rank: 1 }],
    names: { "0x1": "alice" },
  });
  assert.deepEqual(boardArgs, [7, "scout", 2]);
});

test("get_protocol_totals forwards the ETH price and the totals", async () => {
  const all = tools({ ethUsd: async () => 2_000, getLaunchTotals: async () => ({ launches: 3, usd_partial: false }) });
  assert.deepEqual(await run(all, "get_protocol_totals"), { eth_usd: 2_000, totals: { launches: 3, usd_partial: false } });
});
