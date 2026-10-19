/**
 * Applying to list a community pair (pairs.ts). Pure, node --test loads it directly.
 *
 * One rule, stated once:
 *   The fee pays for a review, not a listing. It is $200 worth of TWIG (PAIR_LISTING_USD), sent to 0x…dEaD in one
 *   plain TWIG.transfer whose amount names the application in its last digits (the Boost tag scheme, kind 3):
 *   amount = whole TWIG × 10^18 + 3×10^11 + application id. It cannot be refunded: it is burned. It can only be sent
 *   once the free automatic pre-check passes, and it covers up to 3 reviews of the application within 60 days.
 *
 * The TWIG amount is quoted at the burn step: $200 ÷ the lower of TWIG's spot and 30-minute average price, rounded up
 * to 100,000 TWIG, locked for 30 minutes. A burn sent while its quote is locked counts at that quote; a later one at the
 * price when it is indexed. Burns for one application add up, so a short one is topped up, never sent again whole.
 */
import { TWIG_DECIMALS } from "./twig.ts";
import type { ChainKey } from "../chainKeys.ts";
import type { BoostTransfer } from "./boost.ts";
import { BRAND_X } from "../brand.ts";

export const PAIR_LISTING_USD_DEFAULT = 200;
/** The fee in dollars: PAIR_LISTING_USD, else $200. Server-side only (the env is not public). */
export function pairListingUsd(env: string | undefined = process.env.PAIR_LISTING_USD): number {
  const n = Number(env);
  return Number.isFinite(n) && n >= 10 && n <= 100_000 ? n : PAIR_LISTING_USD_DEFAULT;
}
export const PAIR_QUOTE_LOCK_MS = 30 * 60_000;
/** After a fee quote ends, a transfer sent under it may still be indexing for up to an hour. */
export const PAIR_QUOTE_SETTLE_MS = 60 * 60_000;
/**
 * Until when a fee transfer may still be on its way for an application whose last fee quote ends at `quoteUntil`: the
 * quote's end plus an hour, or null once that has passed (or there was no quote). Nothing that would make such a
 * transfer moot happens before then: no expiry, and no fee waiver (the applicant would burn TWIG for a waived fee).
 */
export function pairSettlingUntil(quoteUntil: number | null, now: number): number | null {
  if (quoteUntil === null) return null;
  const until = quoteUntil + PAIR_QUOTE_SETTLE_MS;
  return until > now ? until : null;
}
export const PAIR_FEE_STEP = 100_000n;
/** A burn total within 2% under the fee counts as paid (rounding, a price tick between quote and send). */
export const PAIR_FEE_TOLERANCE = 0.02;
export const PAIR_REVIEWS_MAX = 3;
export const PAIR_REVIEW_WINDOW_MS = 60 * 24 * 3_600_000;
/** Open applications one wallet may have at once. */
export const PAIR_APPLY_OPEN_MAX = 3;

const UNIT = 10n ** BigInt(TWIG_DECIMALS);
const TAG_SPACE = 10n ** 12n;
/** Kind 3 of the reserved tag space (boost.ts: tags below 10^11 name launches; 1 pinned posts, 2 names, 3 pair applications). */
export const PAIR_TAG_BASE = 3n * 10n ** 11n;
const PAIR_TAG_END = 4n * 10n ** 11n;

export function pairTagOf(id: number | bigint): bigint {
  const n = BigInt(id);
  if (n <= 0n || n >= PAIR_TAG_END - PAIR_TAG_BASE) throw new Error("application id out of range");
  return PAIR_TAG_BASE + n;
}
/** The raw TWIG amount to send for `whole` TWIG and an application. */
export function pairBurnAmount(whole: bigint, id: number | bigint): bigint {
  if (whole <= 0n) throw new Error("amount must be positive");
  return whole * UNIT + pairTagOf(id);
}
/** The application a raw amount names, or null when its tag is not kind 3. */
export function pairApplicationOf(value: bigint): number | null {
  const tag = value % TAG_SPACE;
  return tag > PAIR_TAG_BASE && tag < PAIR_TAG_END ? Number(tag - PAIR_TAG_BASE) : null;
}

export type PairBurnRow = { tx_hash: string; log_index: number; sender: string; application_id: number; whole: string; block_number: string };
/**
 * A TWIG Transfer log → a pair-application burn, or null: not TWIG, not to 0x…dEaD, from an address in `skip` (the
 * launch lockers' and fee vaults' own burns), a tag that is not kind 3, or less than one whole TWIG.
 */
export function pairBurnFromTransfer(t: BoostTransfer, twig: string, dead: string, skip: readonly string[] = []): PairBurnRow | null {
  if (t.address.toLowerCase() !== twig.toLowerCase() || t.to.toLowerCase() !== dead.toLowerCase()) return null;
  const sender = t.from.toLowerCase();
  if (skip.some((s) => s.toLowerCase() === sender)) return null;
  const id = pairApplicationOf(t.value);
  const whole = t.value / UNIT;
  if (id === null || whole < 1n) return null;
  return { tx_hash: t.txHash.toLowerCase(), log_index: t.logIndex, sender, application_id: id, whole: whole.toString(), block_number: t.blockNumber.toString() };
}

/**
 * Whole TWIG for `usd` at TWIG's price: the LOWER of the spot and the 30-minute average (a price pushed up for a moment
 * cannot shrink the fee), rounded up to 100,000. null without a usable price: no quote is ever given without one.
 */
export function pairFeeQuote(usd: number, spot: number | null, twap: number | null): { whole: bigint; priceUsd: number } | null {
  const prices = [spot, twap].filter((p): p is number => p !== null && Number.isFinite(p) && p > 0);
  if (prices.length === 0 || !(usd > 0)) return null;
  const price = Math.min(...prices);
  const raw = BigInt(Math.ceil(usd / price));
  const whole = ((raw + PAIR_FEE_STEP - 1n) / PAIR_FEE_STEP) * PAIR_FEE_STEP;
  return { whole, priceUsd: price };
}

/** What one burn is worth: at the locked quote when it was sent inside that lock (not before it began), else at the price when indexed (null = no price yet). */
export function pairBurnUsd(whole: bigint, sentAt: number, quote: { priceUsd: number; from: number; until: number } | null, liveUsd: number | null): { usd: number; by: "quote" | "live" } | null {
  if (quote && sentAt >= quote.from && sentAt <= quote.until && quote.priceUsd > 0) return { usd: Number(whole) * quote.priceUsd, by: "quote" };
  if (liveUsd !== null && liveUsd > 0) return { usd: Number(whole) * liveUsd, by: "live" };
  return null;
}
export function isPaid(paidUsd: number, feeUsd: number): boolean {
  return paidUsd >= feeUsd * (1 - PAIR_FEE_TOLERANCE);
}

export type PairApplicationStatus = "open" | "paid" | "changes" | "approved" | "rejected" | "expired";
/** An application nobody paid for stops holding its token's place after 48 hours (anyone may then apply again). */
export const PAIR_UNPAID_EXPIRE_MS = 48 * 3_600_000;
/** The applicant may ask for another review: changes were asked, reviews remain, inside 60 days of paying. */
export function canAskAgain(a: { status: PairApplicationStatus; reviews_used: number; paid_at: number | null }, now: number): boolean {
  return a.status === "changes" && a.reviews_used < PAIR_REVIEWS_MAX && a.paid_at !== null && now - a.paid_at < PAIR_REVIEW_WINDOW_MS;
}

/** A short code for the community's proof post: the application id and four letters, e.g. OL-12-K7QX. */
export function applicationCode(id: number, rand: () => number = Math.random): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `OL-${id}-${Array.from({ length: 4 }, () => A[Math.floor(rand() * A.length)]).join("")}`;
}
/** The post the community's own X account makes, so the reviewer can see the application comes from the community. */
export const proofPostText = (code: string, symbol: string) => `We applied to list $${symbol} as a community pair on @${BRAND_X}. Application ${code}`;
/** A link to a post on X (x.com or twitter.com, /<handle>/status/<id>), else null. */
export function proofPostUrl(v: string): string | null {
  const m = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:[/?#].*)?$/.exec(v.trim());
  return m ? `https://x.com/${m[1]}/status/${m[2]}` : null;
}

/** A price source in words, the same on both sides of a signature: "univ3 0x… against 0x… (hook none)". */
export function sourceLabel(s: { price_kind: string; price_pool: string; price_quote: string; price_hook: string }): string {
  return `${s.price_kind} ${s.price_pool.toLowerCase()} against ${s.price_quote.toLowerCase()}${s.price_kind === "univ4" ? ` (hook ${s.price_hook ? s.price_hook.toLowerCase() : "none"})` : ""}`;
}

/* ─────────────────────────────── messages ─────────────────────────────── */

export const PAIR_APPLY_ACTIONS = ["apply", "proof", "again"] as const;
export type PairApplyAction = (typeof PAIR_APPLY_ACTIONS)[number];
export function isPairApplyAction(v: unknown): v is PairApplyAction {
  return typeof v === "string" && (PAIR_APPLY_ACTIONS as readonly string[]).includes(v);
}
/** What the applicant signs. The application's fields are in it, so a signature covers exactly what is stored. */
export function buildPairApplyMessage(p: { action: PairApplyAction; chain: ChainKey; address: string; wallet: string; nonce: string; ts: number; id?: number; source?: string; website?: string; x_handle?: string; logo?: string; description?: string; proof?: string }): string {
  return [
    `openlaunch.lol community pair application`,
    ``,
    `Action: ${p.action}`,
    `Token: ${p.chain}:${p.address.toLowerCase()}`,
    ...(p.id !== undefined ? [`Application: ${p.id}`] : []),
    ...(p.action === "apply" ? [`Price pool: ${p.source || "-"}`, `Website: ${p.website || "-"}`, `X: ${p.x_handle || "-"}`, `Logo: ${p.logo || "-"}`, `About: ${p.description || "-"}`] : []),
    ...(p.action === "proof" ? [`Proof post: ${p.proof || "-"}`] : []),
    `Wallet: ${p.wallet.toLowerCase()}`,
    `Nonce: ${p.nonce}`,
    `Issued: ${new Date(p.ts).toISOString()}`,
  ].join("\n");
}

/** "waive": approve an application that has not paid, the fee waived by openlaunch (an admin call, signed like the rest). */
export const PAIR_REVIEW_DECISIONS = ["approve", "waive", "changes", "reject"] as const;
export const PAIR_FEE_WAIVED = "Fee waived by openlaunch.";
export type PairReviewDecision = (typeof PAIR_REVIEW_DECISIONS)[number];
export function isPairReviewDecision(v: unknown): v is PairReviewDecision {
  return typeof v === "string" && (PAIR_REVIEW_DECISIONS as readonly string[]).includes(v);
}
/** What an admin signs to decide an application. */
export function buildPairReviewMessage(p: { decision: PairReviewDecision; id: number; wallet: string; nonce: string; ts: number; reason: string }): string {
  return [`openlaunch.lol community pair review`, ``, `Decision: ${p.decision}`, `Application: ${p.id}`, `Reason: ${p.reason || "-"}`, `Admin: ${p.wallet.toLowerCase()}`, `Nonce: ${p.nonce}`, `Issued: ${new Date(p.ts).toISOString()}`].join("\n");
}

/* ─────────────────────────────── words ─────────────────────────────── */

export const PAIR_APPLY_COPY = {
  title: "List your token as a community pair",
  lead: "Launches paired with your community's token carry its badge and a USD price everywhere on openlaunch, and reach Trending. Check your token here for free, apply, and a person reviews it.",
  whatYouGet: "A listing gives launches paired with your token its badge, a USD price and a place in Trending, plus a page for the pair. It does not add your token to the launch form (ETH, TWIG and stocks only): your community launches against the factory with its own tools or agents.",
  feeRule: (usd: number) => `The fee is $${usd} in TWIG on Base, sent to 0x…dEaD, whichever chain the token is on. It pays for a review, not a listing, and it cannot be refunded: it is burned. It covers up to 3 reviews within 60 days.`,
  precheckFirst: "The fee can only be sent once the free check passes, so a token that cannot be listed never costs anything.",
  profileNeeded: "Applying needs an openlaunch profile with a verified X account (from your profile page).",
  proofAsk: "Post this from the community's own X account, then paste the post's link here. The reviewer checks it by hand.",
  sentFinal: "The TWIG goes to 0x…dEaD. It cannot be undone or refunded, and nothing is paid to openlaunch or Twigpine.",
  lockNote: "The amount is locked for 30 minutes. Sent later, it counts at the price when it lands; a shortfall can be topped up.",
  reviewNote: "Reviews look at the checks, the community (its X account, its age, its activity) and the proof post. A listing is not an endorsement.",
  disabled: "Applications open soon.",
  waived: "No fee: openlaunch waived it for this application.",
  waivedRest: (paidUsd: number) => `Paid: $${paidUsd.toFixed(2)}. openlaunch waived the rest of the fee.`,
} as const;
