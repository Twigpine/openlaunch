/**
 * The model behind ⌘K search: what it can open, how a query narrows it, and how results group.
 * Pure on purpose (node --test loads it directly); the dialog in components/CommandPalette.tsx
 * only renders these groups and runs the chosen item.
 */

export type PaletteToken = { chain: string; token: string; name: string; symbol: string; image: string | null; capUsd: number | null; change: number; holders: number };

export type PaletteItem =
  | { kind: "token"; id: string; label: string; token: PaletteToken }
  | { kind: "page"; id: string; label: string; href: string; keywords: string }
  | { kind: "action"; id: string; label: string; action: "bridge" | "theme"; keywords: string };

export type PaletteGroup = { value: string; items: PaletteItem[] };

export const PALETTE_PAGES: ReadonlyArray<{ id: string; label: string; href: string; keywords: string }> = [
  { id: "page:home", label: "Launchpad", href: "/", keywords: "home market tokens list trending new top" },
  { id: "page:launch", label: "Launch a token", href: "/launch", keywords: "create deploy new token mint start" },
  { id: "page:feed", label: "Posts", href: "/feed", keywords: "community comments social feed conversation" },
  { id: "page:rules", label: "How it works", href: "/rules", keywords: "rules learn fees locker liquidity contracts risks faq" },
  { id: "page:agents", label: "Agents and API", href: "/agents", keywords: "api developers llms json bots code" },
  { id: "page:me", label: "Your dashboard", href: "/me", keywords: "me wallet portfolio fees collect launches holdings" },
  { id: "page:about", label: "About openlaunch", href: "/about", keywords: "about open source mit" },
  { id: "page:base", label: "Launches on Base", href: "/base", keywords: "base chain network" },
  { id: "page:robinhood", label: "Launches on Robinhood Chain", href: "/robinhood", keywords: "robinhood chain network stocks" },
  { id: "page:arc", label: "Launches on Arc", href: "/arc", keywords: "arc chain network usdc" },
];

/** Token search starts at two characters; one letter matches half the market. */
export function isSearchableQuery(query: string): boolean {
  return query.trim().length >= 2;
}

/** Every word of the query has to appear somewhere in the text, in any order. */
export function matchesQuery(query: string, text: string): boolean {
  const haystack = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

type LaunchLike = { chain: string; token: string; name: string; symbol: string; image_url?: string | null; fdv_usd?: number | null; change_from_launch?: number | null; holders?: number | null };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The fields search needs from a launch row returned by /api/launch/search or /api/launch/list. */
export function paletteTokenFrom(l: LaunchLike): PaletteToken {
  return {
    chain: l.chain,
    token: l.token.toLowerCase(),
    name: l.name,
    symbol: l.symbol,
    image: l.image_url ?? null,
    capUsd: finite(l.fdv_usd) ? l.fdv_usd : null,
    change: finite(l.change_from_launch) ? l.change_from_launch : 0,
    holders: finite(l.holders) ? l.holders : 0,
  };
}

/**
 * Results in reading order: tokens first (search hits, or what is trending before anything is
 * typed), then pages, then actions. Empty groups are dropped.
 */
export function buildPaletteGroups({ query, tokens, trending, theme }: { query: string; tokens: PaletteToken[]; trending: PaletteToken[]; theme: "light" | "dark" }): PaletteGroup[] {
  const q = query.trim();
  const tokenList = q ? (isSearchableQuery(q) ? tokens : []) : trending;
  const tokenItems: PaletteItem[] = tokenList.map((t) => ({ kind: "token", id: `token:${t.chain}:${t.token}`, label: t.name, token: t }));
  const pages: PaletteItem[] = PALETTE_PAGES.filter((p) => !q || matchesQuery(q, `${p.label} ${p.keywords}`)).map((p) => ({ kind: "page", ...p }));
  const next = theme === "dark" ? "light" : "dark";
  const actions: PaletteItem[] = [
    { kind: "action" as const, id: "action:bridge", label: "Bridge funds between chains", action: "bridge" as const, keywords: "bridge relay move deposit base robinhood arc" },
    { kind: "action" as const, id: "action:theme", label: `Switch to the ${next} theme`, action: "theme" as const, keywords: `theme ${next} mode appearance colors` },
  ].filter((a) => !q || matchesQuery(q, `${a.label} ${a.keywords}`));
  return [
    { value: q ? "Tokens" : "Trending now", items: tokenItems },
    { value: "Pages", items: pages },
    { value: "Actions", items: actions },
  ].filter((g) => g.items.length > 0);
}

/** Typing "/" in a field types a slash; everywhere else it opens search. */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
