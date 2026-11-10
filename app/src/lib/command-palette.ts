/**
 * The model behind ⌘K search: what it can open, how a query narrows it, and how results group.
 * Pure on purpose (node --test loads it directly); the dialog in components/CommandPalette.tsx
 * only renders these groups and runs the chosen item.
 */

export type PaletteToken = { chain: string; token: string; name: string; symbol: string; image: string | null; capUsd: number | null; change: number; holders: number };

export type PaletteItem =
  | { kind: "token"; id: string; label: string; token: PaletteToken }
  | { kind: "page"; id: string; label: string; href: string; keywords: string }
  | { kind: "action"; id: string; label: string; action: "bridge" | "theme"; keywords: string; theme?: "light" | "dark" };

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

/**
 * The palette's words in the reader's language (the search area of the messages). Without it everything reads in
 * English. A translated page or action still matches its English label and keywords, so either language finds it.
 */
export type PaletteText = {
  groups: { tokens: string; trending: string; pages: string; actions: string };
  pages: Record<string, { label: string; keywords: string }>;
  actions: Record<"bridge" | "light" | "dark", { label: string; keywords: string }>;
};

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

/** Listed only while the Earn switch is on (GET /api/earn); it lands on the /me card. */
export const EARN_PAGE = { id: "page:earn", label: "Earn on idle USDC", href: "/me#earn", keywords: "earn lend deposit usdc vault morpho interest savings withdraw" } as const;

/** Listed only while the Boost switch is on (the live poll says so); it lands on the home page's Boosted lane. */
export const BOOST_PAGE = { id: "page:boosted", label: "Boosted tokens", href: "/#boosted", keywords: "boost boosted twig burn lane dead" } as const;

/**
 * Results in reading order: tokens first (search hits, or what is trending before anything is
 * typed), then pages, then actions. Empty groups are dropped.
 */
export function buildPaletteGroups({ query, tokens, trending, theme, text, earn = false, boost = false }: { query: string; tokens: PaletteToken[]; trending: PaletteToken[]; theme: "light" | "dark"; text?: PaletteText; earn?: boolean; boost?: boolean }): PaletteGroup[] {
  const q = query.trim();
  const tokenList = q ? (isSearchableQuery(q) ? tokens : []) : trending;
  const tokenItems: PaletteItem[] = tokenList.map((t) => ({ kind: "token", id: `token:${t.chain}:${t.token}`, label: t.name, token: t }));
  const pages: PaletteItem[] = [...PALETTE_PAGES, ...(earn ? [EARN_PAGE] : []), ...(boost ? [BOOST_PAGE] : [])].map((p) => {
    const words = text?.pages[p.id.replace(/^page:/, "")];
    return { kind: "page" as const, ...p, label: words?.label ?? p.label, keywords: words ? `${p.label} ${p.keywords} ${words.keywords}` : p.keywords };
  }).filter((p) => !q || matchesQuery(q, `${p.label} ${p.keywords}`));
  const next: "light" | "dark" = theme === "dark" ? "light" : "dark";
  const english = {
    bridge: { label: "Bridge funds between chains", keywords: "bridge relay move deposit base robinhood arc" },
    theme: { label: `Switch to the ${next} theme`, keywords: `theme ${next} mode appearance colors` },
  };
  const action = (words: { label: string; keywords: string } | undefined, base: { label: string; keywords: string }) => ({
    label: words?.label ?? base.label,
    keywords: words ? `${base.label} ${base.keywords} ${words.keywords}` : base.keywords,
  });
  const everyAction: Extract<PaletteItem, { kind: "action" }>[] = [
    { kind: "action", id: "action:bridge", action: "bridge", ...action(text?.actions.bridge, english.bridge) },
    { kind: "action", id: "action:theme", action: "theme", theme: next, ...action(text?.actions[next], english.theme) },
  ];
  const actions = everyAction.filter((a) => !q || matchesQuery(q, `${a.label} ${a.keywords}`));
  return [
    { value: q ? (text?.groups.tokens ?? "Tokens") : (text?.groups.trending ?? "Trending now"), items: tokenItems },
    { value: text?.groups.pages ?? "Pages", items: pages },
    { value: text?.groups.actions ?? "Actions", items: actions },
  ].filter((g) => g.items.length > 0);
}

/** Typing "/" in a field types a slash; everywhere else it opens search. */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
