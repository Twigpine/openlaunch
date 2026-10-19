/**
 * Community pairs: ERC-20s that launches may be paired with and that the site lists, prices and badges. Pure,
 * node --test loads it directly.
 *
 * One rule, stated once:
 *   The list is the site's, never the contracts'. The factory accepts any ERC-20 as the quote, before and after this
 *   list; a token missing from it shows as an unlisted pair (unlisted-quote.ts). A listing gives a launch paired with it
 *   the community's badge, a USD price read from one named pool and a place in Trending. Never a place in the launch
 *   form: the form offers ETH, TWIG and stocks only, and pairs are launched against the factory by the community's own
 *   tools or agents. Every listing, suspension and delisting is written to a public record on the pair's page.
 *
 * A pair is never "official", "verified" or "safe": the badge says Community pair, and the page shows what was checked.
 * MUSEWORLD, once an official quote in code, is the first pair, under the same rules (db/schema.sql seeds it).
 *
 * Its USD price: quote units per pair token in its price pool, times that quote's own USD price (ETH, USDC, GITLAWB/TWIG).
 * The pool leg is a spot reading checked against a 30-minute time-weighted average, the same >25% rule as GITLAWB's own
 * price, so one swap that pushes the pool for a block cannot rewrite every paired launch's market cap and ranking. A pair
 * with no average (a v3 pool without enough oracle history, a v4 pool without 20 minutes of samples) shows no USD.
 */
import { CHAIN_IDS, CHAIN_LABELS, type ChainKey } from "../chainKeys.ts";
import { amountForUsd } from "./first-buy.ts";
import { fmtCompact } from "./math.ts";
import { CORE_QUOTE_PREFIXES, CORE_QUOTE_SYMBOLS } from "./unlisted-quote.ts";

/** Pairs are listed on Base and Robinhood Chain, where the communities launching on openlaunch are. */
export const PAIR_CHAINS: readonly ChainKey[] = ["base", "robinhood"];
export const isPairChain = (c: ChainKey): boolean => PAIR_CHAINS.includes(c);
/**
 * TWIG's chain. Every application pays its fee here and every pair signature (the applicant's, the admin's) is checked
 * here, whatever chain the pair is on: TWIG lives on Base only, and one chain for the whole flow is one wallet network.
 */
export const PAIR_FEE_CHAIN: ChainKey = "base";
/** "Base and Robinhood Chain": the chains pairs are listed on, in words. */
export const PAIR_CHAINS_TEXT = andList(PAIR_CHAINS.map((c) => CHAIN_LABELS[c]));
function andList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export type PairStatus = "listed" | "suspended" | "delisted";
export type PairPriceKind = "launch" | "univ3" | "univ4";
export const PAIR_PRICE_KINDS: readonly PairPriceKind[] = ["launch", "univ3", "univ4"];
export function isPairPriceKind(v: unknown): v is PairPriceKind {
  return typeof v === "string" && (PAIR_PRICE_KINDS as readonly string[]).includes(v);
}
/** What each price source is, in words for the pair page and the admin form. */
export const PAIR_PRICE_KIND_LABEL: Record<PairPriceKind, string> = {
  launch: "its own openlaunch pool",
  univ3: "a Uniswap v3 (or Aerodrome Slipstream) pool, with its on-chain 30-minute average",
  univ4: "a Uniswap v4 pool, against our own 30-minute record of its price",
};

export const PAIR_TWAP_WINDOW_S = 30 * 60;
export const PAIR_MAX_DEVIATION = 0.25;
/** A v4 pool's average needs samples spanning at least this much of the window before it counts. */
export const PAIR_MIN_SAMPLED_S = 20 * 60;
/** The listing floors (checked before a review) and the monitor's liquidity line: half the floor. */
export const PAIR_MIN_LIQUIDITY_USD = 50_000;
export const PAIR_MONITOR_LIQUIDITY_USD = PAIR_MIN_LIQUIDITY_USD / 2;
export const PAIR_MIN_HOLDERS = 500;
export const PAIR_MIN_AGE_DAYS = 14;
/** Failing checks for this long suspend a listed pair; suspended this long by the monitor, it is delisted. */
export const PAIR_SUSPEND_AFTER_MS = 24 * 3_600_000;
export const PAIR_DELIST_AFTER_MS = 14 * 24 * 3_600_000;
/** How often the monitor checks each pair, and how often a v4 price pool is sampled. */
export const PAIR_MONITOR_EVERY_MS = 60 * 60_000;
export const PAIR_SAMPLE_EVERY_MS = 60_000;

/** A pair as every page and API shows it. `usd` is null when its price cannot be read or fails its check right now. */
export type PairPublic = {
  chain: ChainKey;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo: string | null;
  website: string | null;
  x_handle: string | null;
  description: string | null;
  status: PairStatus;
  status_reason: string | null;
  status_at: string;
  listed_at: string;
  price_kind: PairPriceKind;
  price_pool: string;
  price_quote: string;
  /** A v4 price pool's hook (read from its key on-chain; null = hookless or not a v4 pool). */
  price_hook: string | null;
  usd: number | null;
  /** The monitor's last check, and since when its checks fail (null = passing): public, like the rest of the record. */
  checked_at: string | null;
  failing_since: string | null;
};

/* ─────────────────────────────── names ─────────────────────────────── */

export const PAIR_SYMBOL_MAX = 12;

/**
 * Why a symbol cannot be listed, or null. `taken` = the symbols of the other listed pairs, on every chain (a copy of a
 * community's name on another chain would carry its badge); `stocks` = the chain's stock tickers.
 */
export function pairSymbolProblem(symbol: string, taken: readonly string[], stocks: readonly string[] = []): string | null {
  if (!new RegExp(`^[A-Za-z0-9._-]{1,${PAIR_SYMBOL_MAX}}$`).test(symbol)) return `a symbol is 1 to ${PAIR_SYMBOL_MAX} letters, digits, dots, dashes or underscores`;
  const up = symbol.toUpperCase();
  if (CORE_QUOTE_SYMBOLS.includes(up) || CORE_QUOTE_PREFIXES.some((p) => up.startsWith(p))) return `${symbol} is a core quote's name`;
  if (stocks.some((t) => t.toUpperCase() === up)) return `${symbol} is a stock's ticker`;
  if (taken.some((t) => t.toUpperCase() === up)) return `another listed pair is already ${symbol}`;
  return null;
}

/**
 * The free check's symbol row. `stocks` null = the chain's stock list could not be read (Robinhood's registry before its
 * first good read): a symbol that fails on what is known still fails, otherwise the row is unknown, never a pass.
 */
export function pairSymbolCheck(symbol: string, taken: readonly string[], stocks: readonly string[] | null): { pass: boolean | null; value: string } {
  const problem = pairSymbolProblem(symbol, taken, stocks ?? []);
  if (problem) return { pass: false, value: problem };
  if (stocks === null) return { pass: null, value: `${symbol}: the chain's stock list could not be read to rule out a stock's ticker; try again` };
  return { pass: true, value: symbol };
}

/**
 * A site path to a logo we serve ourselves (the seeded MUSEWORLD tile); uploaded logos are checked against our image host
 * instead. PNG only: the share card inlines these files as they are, and its renderer cannot read WebP.
 */
export function isSiteLogoPath(v: string): boolean {
  return /^\/[a-z0-9][a-z0-9-]{0,40}\.png$/.test(v);
}
export function isPairWebsite(v: string): boolean {
  if (v.length > 200) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".");
  } catch {
    return false;
  }
}
export function isXHandle(v: string): boolean {
  return /^[A-Za-z0-9_]{1,15}$/.test(v);
}
export const PAIR_DESCRIPTION_MAX = 280;

/* ─────────────────────────────── prices ─────────────────────────────── */

/** True when `a` sorts below `b` as an address (Uniswap's token0 / currency0 is the lower one). */
export function sortsBelow(a: string, b: string): boolean {
  return BigInt(a.toLowerCase()) < BigInt(b.toLowerCase());
}

/**
 * Whether a newly listed pair is still gathering its price samples: a v4 pool keeps no oracle, so its 30-minute average
 * needs PAIR_MIN_SAMPLED_S of our own minute samples (plus a little slack for the first ones). Until then a missing
 * average is expected, not a failing check. Other kinds read their average from history that already exists.
 */
export function pairWarmingUp(kind: PairPriceKind, listedAt: number, now: number): boolean {
  return kind === "univ4" && now - listedAt < (PAIR_TWAP_WINDOW_S + 10 * 60) * 1000;
}

/** Whole quote units per whole pair token from a pool's token1-per-token0 raw price. */
export function pairPriceFromRaw(raw1Per0: number, pairIsToken0: boolean, pairDecimals: number, quoteDecimals: number): number | null {
  if (!Number.isFinite(raw1Per0) || !(raw1Per0 > 0)) return null;
  const perPair = pairIsToken0 ? raw1Per0 : 1 / raw1Per0; // quote raw per pair raw
  const v = perPair * 10 ** (pairDecimals - quoteDecimals);
  return Number.isFinite(v) && v > 0 ? v : null;
}
/** From a pool's sqrtPriceX96 (v3 slot0, v4 getSlot0). */
export function pairPriceFromSqrt(sqrtPriceX96: bigint, pairIsToken0: boolean, pairDecimals: number, quoteDecimals: number): number | null {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  return pairPriceFromRaw(s * s, pairIsToken0, pairDecimals, quoteDecimals);
}
/** From a tick (a v3 oracle's average tick). */
export function pairPriceFromTick(tick: number, pairIsToken0: boolean, pairDecimals: number, quoteDecimals: number): number | null {
  return Number.isFinite(tick) ? pairPriceFromRaw(Math.pow(1.0001, tick), pairIsToken0, pairDecimals, quoteDecimals) : null;
}

/**
 * Time-weighted average of a step price over [from, to] (unix seconds). The pool price is a step function: `baseline`
 * holds from `from` until the first point, and each point's price holds until the next one. Without a baseline the
 * window starts at the first point. null when there is nothing to average or an input is unusable.
 */
export function timeWeightedPrice(points: { t: number; price: number }[], baseline: number | null, from: number, to: number): number | null {
  return twapSpan(points, baseline, from, to)?.price ?? null;
}
/** The same average, with how many seconds of the window it covers (a sampled average needs enough of them). */
export function twapSpan(points: { t: number; price: number }[], baseline: number | null, from: number, to: number): { price: number; span: number } | null {
  if (!(to > from)) return null;
  const steps = points.filter((p) => Number.isFinite(p.price) && p.price > 0 && p.t <= to).sort((a, b) => a.t - b.t);
  let level = baseline !== null && Number.isFinite(baseline) && baseline > 0 ? baseline : null;
  let at = from;
  let area = 0;
  let span = 0;
  for (const p of steps) {
    const t = Math.max(p.t, from);
    if (level !== null && t > at) {
      area += level * (t - at);
      span += t - at;
    }
    level = p.price;
    at = t;
  }
  if (level !== null && to > at) {
    area += level * (to - at);
    span += to - at;
  }
  return span > 0 ? { price: area / span, span } : null;
}

/**
 * The pool leg to publish, the GITLAWB rule (gitlawb.ts reconcileGitlawbUsd) with one difference: a pair needs its
 * average. The spot is used unless it strays more than 25% from the average, then the average; no average, no price.
 */
export function guardedPairPrice(spot: number | null, twap: number | null, maxDeviation = PAIR_MAX_DEVIATION): { price: number | null; source: "spot" | "twap" | null; deviation: number | null } {
  if (twap === null || !(twap > 0)) return { price: null, source: null, deviation: null };
  if (spot === null || !(spot > 0)) return { price: twap, source: "twap", deviation: null };
  const deviation = Math.abs(spot - twap) / twap;
  return deviation > maxDeviation ? { price: twap, source: "twap", deviation } : { price: spot, source: "spot", deviation };
}

/** Quick-pick buy amounts in a pair: about $5, $25, $100 and $500 of it at its current price (none without a price). */
export const PAIR_BUY_USD = [5, 25, 100, 500];
export function pairBuyPresets(usd: number | null, decimals: number): string[] {
  if (usd === null || !(usd > 0)) return [];
  return PAIR_BUY_USD.map((d) => amountForUsd(d, usd, decimals)).filter((s): s is string => s !== null);
}

/* ─────────────────────────────── status ─────────────────────────────── */

/** One monitor reading of a pair: healthy, failing (hard = at once, e.g. its code changed), or unknown (nothing could be read). */
export type PairHealth = { ok: true } | { ok: false; hard: boolean; reason: string } | null;
export type PairState = { status: PairStatus; status_by: "admin" | "monitor"; status_at: number; failing_since: number | null };
export type PairStep = PairState & { changed: boolean; reason: string | null };

/**
 * What the monitor does with a reading. Unknown readings change nothing. A listed pair failing a soft check for 24
 * hours, or a hard check once, is suspended; a pair the MONITOR suspended comes back by itself when its checks pass,
 * and is delisted after 14 days without that. An admin's suspension and every delisting are left alone: only an admin
 * reverses those.
 */
export function nextPairStatus(cur: PairState, health: PairHealth, now: number): PairStep {
  const same = (patch: Partial<PairState> = {}): PairStep => ({ ...cur, ...patch, changed: false, reason: null });
  const move = (status: PairStatus, reason: string): PairStep => ({ status, status_by: "monitor", status_at: now, failing_since: status === "listed" ? null : cur.failing_since ?? now, changed: true, reason });
  if (health === null || cur.status === "delisted") return same();
  if (cur.status === "suspended" && cur.status_by === "admin") return same();
  if (health.ok) {
    if (cur.status === "suspended") return { ...move("listed", "Checks pass again."), failing_since: null };
    return same({ failing_since: null });
  }
  if (cur.status === "listed") {
    if (health.hard) return move("suspended", health.reason);
    const since = cur.failing_since ?? now;
    return now - since >= PAIR_SUSPEND_AFTER_MS ? move("suspended", `${health.reason} (for 24 hours)`) : same({ failing_since: since });
  }
  // suspended by the monitor and still failing
  return now - cur.status_at >= PAIR_DELIST_AFTER_MS ? move("delisted", "Suspended for 14 days without the checks passing again.") : same();
}

/* ─────────────────────────────── admin ─────────────────────────────── */

export const PAIR_ADMIN_ACTIONS = ["list", "update", "suspend", "delist", "reinstate"] as const;
export type PairAdminAction = (typeof PAIR_ADMIN_ACTIONS)[number];
export function isPairAdminAction(v: unknown): v is PairAdminAction {
  return typeof v === "string" && (PAIR_ADMIN_ACTIONS as readonly string[]).includes(v);
}
/** The fields a list/update writes; every one is in the signed message, so a signature covers exactly what is stored. */
export type PairListing = { logo: string; website: string; x_handle: string; description: string; price_kind: PairPriceKind; price_pool: string; price_quote: string; price_hook: string /* univ4: "" = hookless, else the hook the admin names */ };

/** The text an admin wallet signs to list, change, suspend, delist or reinstate a pair. Its own wording: no other signature replays here. */
export function buildPairAdminMessage(p: { action: PairAdminAction; chain: ChainKey; address: string; wallet: string; nonce: string; ts: number; reason?: string; listing?: PairListing }): string {
  const l = p.listing;
  return [
    `openlaunch.lol community pairs`,
    ``,
    `Action: ${p.action}`,
    `Pair: ${p.chain}:${p.address.toLowerCase()}`,
    ...(l
      ? [
          `Price: ${l.price_kind} ${l.price_pool.toLowerCase()} against ${l.price_quote.toLowerCase()}${l.price_kind === "univ4" ? ` (hook ${l.price_hook ? l.price_hook.toLowerCase() : "none"})` : ""}`,
          `Logo: ${l.logo || "-"}`,
          `Website: ${l.website || "-"}`,
          `X: ${l.x_handle || "-"}`,
          `About: ${l.description || "-"}`,
        ]
      : []),
    ...(p.reason !== undefined ? [`Reason: ${p.reason || "-"}`] : []),
    `Admin: ${p.wallet.toLowerCase()}`,
    `Nonce: ${p.nonce}`,
    `Issued: ${new Date(p.ts).toISOString()}`,
  ].join("\n");
}

/* ─────────────────────────────── words ─────────────────────────────── */

export const pairPath = (chain: ChainKey, address: string) => `/pair/${chain}/${address.toLowerCase()}`;
/** A pair's heading: its name, with the symbol when it says something more. */
export const pairTitle = (p: { name: string; symbol: string }) => (p.name.toUpperCase() === p.symbol.toUpperCase() ? p.name : `${p.name} (${p.symbol})`);
/** Dollar volume on the pair pages: compact, and never ten decimals for a few cents. */
export function pairVolumeLabel(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd)) return "–";
  if (usd === 0) return "$0";
  if (usd < 1) return "under $1";
  return usd < 1000 ? `$${Math.round(usd)}` : `$${fmtCompact(usd, 1).replace(/\.0([KMBT])$/, "$1")}`;
}
export const pairChainId = (chain: ChainKey) => CHAIN_IDS[chain];

/** Every sentence the feature shows, in one place, so a test can hold them to the rules (no value talk, no seal words). */
export const PAIR_COPY = {
  badge: "Community pair",
  badgeTitle: (symbol: string) => `Paired with ${symbol}, a community pair: listed after public checks, not an endorsement. Buyers pay in ${symbol}.`,
  pageNote: "Listed after public checks. Not an endorsement: check the token yourself.",
  about: (symbol: string) => `Paired with ${symbol}, a community pair on openlaunch: a token the site lists after public checks, with its price read from one named pool. Not an endorsement.`,
  suspended: (symbol: string, reason: string | null) => `Its pair, ${symbol}, is suspended${reason ? `: ${reason}` : ""}. Its launches still trade, with no USD price and no badge, until it is listed again.`,
  delisted: (symbol: string) => `Its pair, ${symbol}, was delisted. Its launches still trade, as an unlisted pair.`,
  indexTitle: "Community pairs",
  indexLead: "Community tokens that launches are paired with. A listed pair's launches carry its badge and a USD price everywhere on openlaunch. Each is listed after public checks, priced from one named pool, and watched every hour: a pair whose checks fail for a day is suspended. The contracts accept any token as the pair; this list is the site's.",
  noForm: "The launch form offers ETH, TWIG and stocks only. A launch paired with a community token is made straight against the factory, by the community's own tools or agents.",
  indexEmpty: "No community pairs yet.",
  applySoon: "Applications to list a token open soon.",
} as const;
