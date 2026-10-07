/**
 * The picture a real launch puts on the hero locker's coin, and when. Pure, so node --test loads it directly.
 *
 * The coin is the one place a creator's picture reaches the hero, so it is held to four rules. The picture must be one
 * of OUR stored images: an exact match on our image host and key shape, never any other URL. It must be its token's own:
 * the first token to register a picture owns it, so the same picture on a later token never reaches the coin (the feed
 * marks those, `image_reused`). A launch whose name or symbol imitates a brand loses its picture (the caption still shows).
 * And no token name or symbol is ever drawn there at all. These are speed bumps, not a moderator: a creator can still upload
 * a picture of their own that resembles something, which is why the picture can be switched off (HERO_COIN_PICTURES=off).
 */
import { feedKey } from "./river";
import type { ChainKey } from "@/lib/chainPublic";
import type { FeedItem } from "./queries";

/** A launch's picture stays on the coin this long, measured on the poll's clock. */
export const COIN_LIFE_MS = 15_000;
/** Only a launch this young when first seen is news: a tab waking from sleep must not replay the last half hour. */
export const FRESH_LAUNCH_MS = 120_000;
const FUTURE_SKEW_MS = 60_000;
const SEEN_CAP = 100;
/** The shape of a key in our image store (images.ts: 24 random bytes, as hex). */
const OWN_KEY = /^t\/[0-9a-f]{48}\.webp$/;

/** `src` when it is exactly `<our image base>/t/<48 hex>.webp`, else null. Nothing after the key (no query, no fragment). */
export function ownImage(src: string | null | undefined, base: string | null | undefined): string | null {
  if (!src || !base) return null;
  const prefix = `${base.replace(/\/+$/, "")}/`;
  return src.startsWith(prefix) && OWN_KEY.test(src.slice(prefix.length)) ? src : null;
}

/** A name with its disguises undone: fullwidth, circled and styled letters become plain ones (NFKC), accents and other combining marks go. */
const plain = (s: string) => s.normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
/**
 * Letters drawn like Latin ones that NFKC leaves alone: whole scripts whose letters pass for Latin ones (a Cyrillic "о" is a
 * Latin "o", a Greek "ο" too), and Latin-script letters outside a to z (ɡ, ı, ᴏ). A name using any of them cannot be checked
 * against the brand words, so its picture is dropped (the caption still shows). Han, Kana, Hangul, Thai, Arabic and the like
 * cannot spell a Latin word, so those names keep theirs.
 */
const DISGUISED = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}\p{Script=Coptic}\p{Script=Georgian}\p{Script=Lisu}]|(?![a-z])\p{Script=Latin}/u;
// letters a digit or sign is often used for, so "0penLaunch", "TW1G" and "GitIawb" fold to what they imitate. An i, an l, a 1, a | and a !
// are all one letter here (a capital I and a lowercase l look the same). Everything that is not a letter a to z is then dropped.
const FOLD: Record<string, string> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", $: "s", "@": "a", "1": "l", "!": "l", "|": "l", i: "l" };
const fold = (s: string) => plain(s).replace(/[03457$@1!|i]/g, (c) => FOLD[c]).replace(/vv/g, "w").replace(/[^a-z]/g, "");
/** Names that must not appear to come from us, a chain, an exchange or a stablecoin: anywhere in the name or the symbol. */
const FRAGMENTS = ["openlaunch", "gitlawb", "twigpine", "twig", "coinbase", "robinhood", "uniswap", "official"].map(fold);
/** Symbols and names that are exactly one of these are held back too (short words would hit too many honest tokens as fragments). */
const EXACT = new Set(["ol", "base", "arc", "eth", "weth", "usdc", "usdg"].map(fold));

/** Whether a launch's name or symbol imitates a brand (the picture is dropped; the launch itself is untouched). */
export function brandLookalike(name: string, symbol: string): boolean {
  if (DISGUISED.test(plain(name)) || DISGUISED.test(plain(symbol))) return true;
  return [fold(name), fold(symbol)].some((t) => FRAGMENTS.some((f) => t.includes(f)) || EXACT.has(t));
}

type Launch = Extract<FeedItem, { kind: "launch" }>;
/** What the coin shows: the caption names a chain; `src` is the picture, null when there is none to show. */
export type CoinReaction = { key: string; chain: ChainKey; src: string | null; since: number };

export function coinReaction(item: Launch, base: string | null, at: number): CoinReaction {
  const own = !item.image_reused && !brandLookalike(item.name, item.symbol);
  return { key: feedKey(item), chain: item.chain, src: own ? ownImage(item.image_url, base) : null, since: at };
}

/**
 * What one poll's feed does to the coin: the newest launch that is new (not in `seen`) and young. Every launch in the feed
 * is remembered, so the page's own launches and a re-sent poll never react. Newest first, as the feed is.
 */
export function pickLaunch(feed: readonly FeedItem[], seen: ReadonlySet<string>, at: number, base: string | null): { reaction: CoinReaction | null; seen: Set<string> } {
  const nextSeen = new Set(seen);
  let reaction: CoinReaction | null = null;
  for (const item of feed) {
    if (item.kind !== "launch") continue;
    const key = feedKey(item);
    if (nextSeen.has(key)) continue;
    nextSeen.add(key);
    const age = at - new Date(item.at).getTime();
    if (reaction === null && Number.isFinite(age) && age <= FRESH_LAUNCH_MS && age >= -FUTURE_SKEW_MS) reaction = coinReaction(item, base, at);
  }
  for (const key of nextSeen) {
    if (nextSeen.size <= SEEN_CAP) break;
    nextSeen.delete(key);
  }
  return { reaction, seen: nextSeen };
}

/** The coin shows a reaction for COIN_LIFE_MS after the poll that brought it. */
export const coinActive = (reaction: CoinReaction | null, now: number): reaction is CoinReaction => reaction !== null && now - reaction.since < COIN_LIFE_MS;
