import { CHAIN_KEYS, type ChainKey } from "@/lib/chainPublic";
import { getHolderPanel } from "@/lib/launchpad/holdersServer";
import { listFeed, listTokenPosts } from "@/lib/launchpad/postsServer";
import { loadPairs } from "@/lib/launchpad/pairsServer";
import { boardRows, publicSeason } from "@/lib/points/server";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { getLaunch, getLaunchFeed, getLaunchTotals, getSwaps, listLaunchesPage, searchLaunches } from "@/lib/launchpad/queries";
import type { LaunchSort, VolumeWindow } from "@/lib/launchpad/queries";
import type { LaunchFilter } from "@/lib/launchpad/search";
import type { McapMode } from "@/lib/launchpad/mcap-policy";
import { ToolError, type McpTool } from "./server.ts";

const ADDRESS = "^0x[0-9a-fA-F]{40}$";

/**
 * Everything a tool can reach. Injected so `tools.test.ts` can exercise the
 * argument handling and output shape without a database, an RPC endpoint, or
 * a live price feed. The defaults are the app's own read model: the same
 * functions the site and `/api/launch/*` use, never a second query.
 */
export type McpToolDeps = {
  ethUsd: typeof ethUsd;
  listLaunchesPage: typeof listLaunchesPage;
  getLaunch: typeof getLaunch;
  getSwaps: typeof getSwaps;
  searchLaunches: typeof searchLaunches;
  getLaunchFeed: typeof getLaunchFeed;
  getHolderPanel: typeof getHolderPanel;
  listFeed: typeof listFeed;
  listTokenPosts: typeof listTokenPosts;
  loadPairs: typeof loadPairs;
  publicSeason: typeof publicSeason;
  boardRows: typeof boardRows;
  getLaunchTotals: typeof getLaunchTotals;
};

const defaults: McpToolDeps = {
  ethUsd,
  listLaunchesPage,
  getLaunch,
  getSwaps,
  searchLaunches,
  getLaunchFeed,
  getHolderPanel,
  listFeed,
  listTokenPosts,
  loadPairs,
  publicSeason,
  boardRows,
  getLaunchTotals,
};

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const chainProperty = {
  type: "string" as const,
  description: "Chain to read: base, robinhood, arc or elysium. Omit for every configured chain.",
  enum: CHAIN_KEYS,
};

const tokenProperty = {
  type: "string" as const,
  description: "Token contract address (0x followed by 40 hex characters).",
  pattern: ADDRESS,
};

const limitProperty = (max: number, fallback: number) => ({
  type: "integer" as const,
  description: `Maximum number of rows to return (1-${max}).`,
  minimum: 1,
  maximum: max,
  default: fallback,
});

/** The public tools. Order is the order `tools/list` serves. */
export function createMcpTools(overrides: Partial<McpToolDeps> = {}): McpTool[] {
  const deps: McpToolDeps = { ...defaults, ...overrides };

  return [
    {
      name: "list_launches",
      title: "List launches",
      description:
        "Browse openlaunch tokens with the site's own sorts. Returns launch facts (price, FDV, USD values, volume windows, holders), not scores. " +
        "sort=live is the home page's ranking: tokens an outside wallet traded in the last day first, then new, then quiet. " +
        "mcap=filtered applies the site's browsing filter; mcap=all lists every valuation.",
      inputSchema: {
        type: "object",
        properties: {
          chain: chainProperty,
          sort: {
            type: "string",
            description: "Ranking to use.",
            enum: ["live", "new", "mcap", "volume", "gainers", "holders"],
            default: "live",
          },
          window: {
            type: "string",
            description: "Volume window for sort=volume.",
            enum: ["1h", "24h", "all"],
            default: "all",
          },
          mcap: {
            type: "string",
            description: "Market-cap browsing mode: all valuations, or the site's filtered view.",
            enum: ["all", "filtered"],
            default: "all",
          },
          filter: {
            type: "string",
            description: "Optional launch filter: fee0 (no trading fee), burn (all fees burned), usdg, usdc.",
            enum: ["fee0", "burn", "usdg", "usdc"],
          },
          launcher: {
            type: "string",
            description: "Only launches by this wallet address.",
            pattern: ADDRESS,
          },
          limit: limitProperty(25, 10),
          offset: {
            type: "integer",
            description: "Rows to skip, for paging.",
            minimum: 0,
            maximum: 10_000,
            default: 0,
          },
        },
        additionalProperties: false,
      },
      annotations: { title: "List launches", ...readOnly },
      run: async (args) => {
        const usd = await deps.ethUsd();
        const page = await deps.listLaunchesPage({
          sort: args.sort as LaunchSort,
          window: args.window as VolumeWindow,
          mcap: args.mcap as McapMode,
          filter: (args.filter as LaunchFilter | undefined) ?? null,
          chain: (args.chain as ChainKey | undefined) ?? null,
          launcher: args.launcher as string | undefined,
          limit: args.limit as number,
          offset: args.offset as number,
          ethUsd: usd,
        });
        return { eth_usd: usd, has_more: page.hasMore, launches: page.items };
      },
    },

    {
      name: "get_launch",
      title: "Get one launch",
      description:
        "One launch's full indexed record by chain and token address: on-chain launch facts, pool and fee settings, live price, " +
        "market cap, volume and holder count. Returns an error when the token is not an openlaunch launch on that chain.",
      inputSchema: {
        type: "object",
        properties: { chain: { ...chainProperty, description: "Chain the token was launched on." }, token: tokenProperty },
        required: ["chain", "token"],
        additionalProperties: false,
      },
      annotations: { title: "Get one launch", ...readOnly },
      run: async (args) => {
        const usd = await deps.ethUsd();
        const launch = await deps.getLaunch(args.chain as ChainKey, (args.token as string).toLowerCase(), usd);
        if (!launch) throw new ToolError(`no launch at ${String(args.token)} on ${String(args.chain)}`);
        return { eth_usd: usd, launch };
      },
    },

    {
      name: "get_token_trades",
      title: "Get a token's trades",
      description: "The newest indexed swaps for one launch, newest first, with quote and token amounts in display units.",
      inputSchema: {
        type: "object",
        properties: {
          chain: { ...chainProperty, description: "Chain the token was launched on." },
          token: tokenProperty,
          limit: limitProperty(50, 20),
        },
        required: ["chain", "token"],
        additionalProperties: false,
      },
      annotations: { title: "Get a token's trades", ...readOnly },
      run: async (args) => {
        const chain = args.chain as ChainKey;
        const token = (args.token as string).toLowerCase();
        const launch = await deps.getLaunch(chain, token);
        if (!launch) throw new ToolError(`no launch at ${token} on ${chain}`);
        return { chain, token, trades: await deps.getSwaps(chain, token, launch.quote_decimals, args.limit as number) };
      },
    },

    {
      name: "get_token_holders",
      title: "Get token holders",
      description:
        "Holder distribution and trust facts for one launch: top holders, top-10 share, pool share, creator bought/sold, " +
        "launch-window snipers, and the panel's plain-language notes. Facts only; there is no score.",
      inputSchema: {
        type: "object",
        properties: {
          chain: { ...chainProperty, description: "Chain the token was launched on." },
          token: tokenProperty,
        },
        required: ["chain", "token"],
        additionalProperties: false,
      },
      annotations: { title: "Get token holders", ...readOnly },
      run: async (args) => {
        const chain = args.chain as ChainKey;
        const token = (args.token as string).toLowerCase();
        const panel = await deps.getHolderPanel(chain, token);
        if (!panel) throw new ToolError(`holder data is unavailable for ${token} on ${chain}`);
        return { chain, token, ...panel };
      },
    },

    {
      name: "search_launches",
      title: "Search launches",
      description: "Search launches by name or symbol substring, or an exact token address. Relevance first, then newest or most-held.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, symbol, or exact token address.", minLength: 1, maxLength: 80 },
          chain: chainProperty,
          order: {
            type: "string",
            description: "Tie-break order: newest first, or most-held first.",
            enum: ["newest", "holders"],
            default: "newest",
          },
          limit: limitProperty(25, 10),
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { title: "Search launches", ...readOnly },
      run: async (args) => {
        const usd = await deps.ethUsd();
        const launches = await deps.searchLaunches(args.query as string, {
          chain: (args.chain as ChainKey | undefined) ?? null,
          limit: args.limit as number,
          ethUsd: usd,
          order: args.order as "newest" | "holders",
        });
        return { query: args.query, eth_usd: usd, launches };
      },
    },

    {
      name: "get_recent_activity",
      title: "Get recent activity",
      description: "The newest launches and swaps across every chain, merged newest first, in the shape the home page's live tape uses.",
      inputSchema: {
        type: "object",
        properties: { limit: limitProperty(50, 20) },
        additionalProperties: false,
      },
      annotations: { title: "Get recent activity", ...readOnly },
      run: async (args) => {
        const usd = await deps.ethUsd();
        return { eth_usd: usd, activity: await deps.getLaunchFeed(args.limit as number, usd) };
      },
    },

    {
      name: "list_posts",
      title: "List community posts",
      description:
        "Wallet-signed community posts. scope=feed returns the newest top-level posts across the site; scope=token returns one token's " +
        "posts with a cursor. Hidden and reported posts are never returned.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", description: "The site-wide feed, or one token's thread.", enum: ["feed", "token"], default: "feed" },
          chain: { ...chainProperty, description: "Required for scope=token: the token's chain." },
          token: { ...tokenProperty, description: "Required for scope=token: the token address." },
          limit: limitProperty(50, 20),
          before_id: {
            type: "integer",
            description: "scope=token only: return posts older than this post id (the previous response's next_cursor).",
            minimum: 1,
          },
        },
        additionalProperties: false,
      },
      annotations: { title: "List community posts", ...readOnly },
      run: async (args) => {
        const limit = args.limit as number;
        if (args.scope === "token") {
          if (typeof args.chain !== "string" || typeof args.token !== "string") {
            throw new ToolError("scope=token needs both chain and token");
          }
          const result = await deps.listTokenPosts(args.chain as ChainKey, args.token.toLowerCase(), limit, (args.before_id as number | undefined) ?? null);
          return { scope: "token", chain: args.chain, token: args.token.toLowerCase(), ...result };
        }
        return { scope: "feed", posts: await deps.listFeed(limit, 0) };
      },
    },

    {
      name: "list_community_pairs",
      title: "List community pairs",
      description:
        "Community tokens the site badges and prices in USD. Returns the pair's record and price source. Listing is not an endorsement; " +
        "suspended and delisted pairs are excluded.",
      inputSchema: {
        type: "object",
        properties: { chain: chainProperty },
        additionalProperties: false,
      },
      annotations: { title: "List community pairs", ...readOnly },
      run: async (args) => {
        const chain = args.chain as ChainKey | undefined;
        const pairs = (await deps.loadPairs()).filter((pair) => pair.status === "listed" && (!chain || pair.chain === chain));
        return { count: pairs.length, pairs };
      },
    },

    {
      name: "get_points_leaderboard",
      title: "Get the points leaderboard",
      description:
        "The public season's creator or scout board. Points are computed hourly from chain activity; the response includes the season's " +
        "dates, whether the board is final, and each wallet's short reason. Returns season=null before a season is public.",
      inputSchema: {
        type: "object",
        properties: {
          board: { type: "string", description: "creator or scout.", enum: ["creator", "scout"], default: "creator" },
          limit: limitProperty(100, 25),
        },
        additionalProperties: false,
      },
      annotations: { title: "Get the points leaderboard", ...readOnly },
      run: async (args) => {
        const season = await deps.publicSeason();
        if (!season) return { season: null, board: args.board, rows: [], names: {} };
        const board = args.board as "creator" | "scout";
        const data = await deps.boardRows(season.id, board, args.limit as number);
        return { season, board, ...data };
      },
    },

    {
      name: "get_protocol_totals",
      title: "Get protocol totals",
      description:
        "The site's all-time totals: launches, trades, USD volume valued at each trade's own hour, fees paid to creators, fees burned, " +
        "and per-chain counts. A quote with no price is reported as a partial USD figure, never guessed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "Get protocol totals", ...readOnly },
      run: async () => {
        const usd = await deps.ethUsd();
        return { eth_usd: usd, totals: await deps.getLaunchTotals(usd) };
      },
    },
  ];
}
