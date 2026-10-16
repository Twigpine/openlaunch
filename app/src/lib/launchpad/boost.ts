/**
 * Boost: TWIG sent to 0x…dEaD buys a token a place in the Boosted lane for 24 hours. Pure, node --test loads it directly.
 *
 * One rule, stated once:
 *   A boost is one plain TWIG.transfer(0x…dEaD, amount) on Base whose amount names the launch in its last digits:
 *   amount = whole TWIG × 10^18 + the launch's position id (bb_launches.token_id, unique on Base's PositionManager).
 *   The tag is worth less than 10^-6 TWIG, so wallets show the whole amount. It lives in the Transfer event itself:
 *   the indexer reads logs only, and a plain wallet, a smart wallet, a Safe and an agent all boost the same way.
 *
 * The Boosted lane is a separate, labelled surface. It is never read by the Live sort, the Trending board or
 * ranking.ts (boost-ui.test.ts guards that): a token cannot buy its way into the facts-only ranking.
 * Nothing reaches Twigpine: the TWIG is gone, and the GITLAWB behind it stays in the TWIG contract.
 */
import { TWIG_ADDRESS, TWIG_DECIMALS, TWIG_SYMBOL } from "./twig.ts";
import { CHAIN_IDS } from "../chainKeys.ts";

/** Boosts exist on Base only: TWIG has not been bridged anywhere. */
export const BOOST_CHAIN = "base" as const;
export const BOOST_CHAIN_ID = CHAIN_IDS[BOOST_CHAIN];
/** Lowercase, like every address the indexer compares. */
export const BOOST_DEAD = "0x000000000000000000000000000000000000dead";
export const BOOST_TOKEN = TWIG_ADDRESS;
/** The least a boost may send, in whole TWIG. In TWIG, not dollars, so a pushed TWIG price cannot move it. */
export const BOOST_FLOOR_TWIG = 100_000n;
export const BOOST_WINDOW_H = 24;
export const BOOST_WINDOW_MS = BOOST_WINDOW_H * 3_600_000;
/** Cards in the lane: the leader and four, like the Trending board. */
export const BOOST_LANE_SIZE = 5;
export const BOOST_PRESETS = ["100000", "300000", "1000000", "5000000"] as const;
/** The largest whole amount the dialog accepts: more than every TWIG in existence, so it only stops typos. */
export const BOOST_MAX_TWIG = 10n ** 11n;

const UNIT = 10n ** BigInt(TWIG_DECIMALS);
/** The last 12 digits of a boost's raw amount are its tag. */
export const TAG_SPACE = 10n ** 12n;
/** Tags below this name a launch by its position id; tags from here up are reserved for later kinds (pinned posts, names). */
export const LAUNCH_TAG_MAX = 10n ** 11n;

/** True for a position id a boost can carry in its last digits. */
export function isLaunchTag(tag: bigint): boolean {
  return tag > 0n && tag < LAUNCH_TAG_MAX;
}

/** The raw amount for a boost of `whole` TWIG on the launch with position id `tag`. */
export function boostAmount(whole: bigint, tag: bigint): bigint {
  if (whole < 1n) throw new Error("a boost sends at least 1 TWIG");
  if (!isLaunchTag(tag)) throw new Error("not a launch tag");
  return whole * UNIT + tag;
}

/** What a raw amount names: its tag (last 12 digits). */
export function boostTagOf(raw: bigint): bigint {
  return raw % TAG_SPACE;
}

/** Whole TWIG in a raw amount (the tag is far below one TWIG). */
export function boostWholeOf(raw: bigint): bigint {
  return raw / UNIT;
}

/** The most whole TWIG a balance can boost with, the tag included; 0 when it cannot pay one TWIG and the tag. */
export function maxBoostWhole(balance: bigint, tag: bigint): bigint {
  let w = balance / UNIT;
  if (w > 0n && w * UNIT + tag > balance) w -= 1n;
  return w;
}

/** The dialog's amount box: whole TWIG only, digits with optional grouping commas, at least 1, at most BOOST_MAX_TWIG. */
export function parseBoostWhole(input: string): bigint | null {
  const s = input.replace(/[,\s_]/g, "");
  if (!/^\d{1,12}$/.test(s)) return null;
  const n = BigInt(s);
  return n >= 1n && n <= BOOST_MAX_TWIG ? n : null;
}

/** Why an amount cannot be sent yet, or null when it can. */
export function boostAmountProblem(whole: bigint | null, balance: bigint | undefined, tag: bigint): string | null {
  if (whole === null) return "Enter a whole number of TWIG.";
  if (whole < BOOST_FLOOR_TWIG) return `A boost sends at least ${groupWhole(BOOST_FLOOR_TWIG)} TWIG.`;
  if (balance !== undefined && boostAmount(whole, tag) > balance) return "Not enough TWIG in this wallet.";
  return null;
}

/** "1,000,000": every digit, grouped (what the wallet will be asked to send, never rounded). */
export function groupWhole(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const UNITS: readonly [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];

/** "1.2M", "300K", "999.99K", "1M" (never "1000K": a value that rounds up to the next unit takes that unit). */
export function compactWhole(whole: number): string {
  for (const [u, s] of UNITS) {
    if (whole >= u * 0.999995) return `${(whole / u).toFixed(2).replace(/\.?0+$/, "")}${s}`;
  }
  return Math.floor(whole).toString();
}

/** "1.2M TWIG", "300K TWIG" from a raw amount (lane cards, the token page line). */
export function fmtBoostTwig(raw: bigint | string): string {
  return `${compactWhole(Number(boostWholeOf(BigInt(raw))))} ${TWIG_SYMBOL}`;
}

/* ─────────────────────────────── the indexer's half ─────────────────────────────── */

/** One ERC-20 Transfer log, as the indexer hands it over (addresses in any case). */
export type BoostTransfer = { address: string; from: string; to: string; value: bigint; txHash: string; logIndex: number; blockNumber: bigint };
/** The row a boost becomes: raw facts only. The launch is joined at read time, by tag. */
export type BoostRow = { tx_hash: string; log_index: number; booster: string; amount: string; tag: string; block_number: string };

/**
 * A Transfer log → a boost row, or null when it is not one: not TWIG, not to 0x…dEaD, sent by an address in `skip`
 * (launch lockers' and fee vaults' own burns), a tag that names no launch, or less than the floor.
 */
export function boostFromTransfer(t: BoostTransfer, skip: readonly string[] = []): BoostRow | null {
  if (t.address.toLowerCase() !== BOOST_TOKEN) return null;
  if (t.to.toLowerCase() !== BOOST_DEAD) return null;
  const booster = t.from.toLowerCase();
  if (skip.some((s) => s.toLowerCase() === booster)) return null;
  const tag = boostTagOf(t.value);
  if (!isLaunchTag(tag)) return null;
  if (boostWholeOf(t.value) < BOOST_FLOOR_TWIG) return null;
  return { tx_hash: t.txHash.toLowerCase(), log_index: t.logIndex, booster, amount: t.value.toString(), tag: tag.toString(), block_number: t.blockNumber.toString() };
}

/* ─────────────────────────────── the lane ─────────────────────────────── */

/** A token's boosts inside the window, summed (the database groups; this orders). */
export type LaneTotals = { token: string; twig: string; boosts: number; boosters: number; last_at: string; last_tx: string };

/** Most TWIG in the window first; a tie goes to the newer boost, then to the address, so the order never flickers. */
export function rankLane<T extends LaneTotals>(rows: readonly T[], size = BOOST_LANE_SIZE): T[] {
  return [...rows]
    .sort((a, b) => {
      const d = BigInt(b.twig) - BigInt(a.twig);
      if (d !== 0n) return d > 0n ? 1 : -1;
      const t = Date.parse(b.last_at) - Date.parse(a.last_at);
      if (t !== 0) return t;
      return a.token < b.token ? -1 : a.token > b.token ? 1 : 0;
    })
    .slice(0, size);
}

/** When a token leaves the lane: 24 hours after its newest boost. */
export function boostExpiresAt(lastAt: string): number {
  return Date.parse(lastAt) + BOOST_WINDOW_MS;
}

/** "23h left", "45m left", "under 1m left"; null once the boost has run out. */
export function boostTimeLeft(lastAt: string, nowMs: number): string | null {
  const ms = boostExpiresAt(lastAt) - nowMs;
  if (!(ms > 0)) return null;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "under 1m left";
  if (m < 60) return `${m}m left`;
  return `${Math.floor(m / 60)}h left`;
}

/** How much of a boost's 24 hours is left, 0 to 1: the length of the card's fuse. */
export function boostFuse(lastAt: string, nowMs: number): number {
  const left = (boostExpiresAt(lastAt) - nowMs) / BOOST_WINDOW_MS;
  return Number.isFinite(left) ? Math.min(1, Math.max(0, left)) : 0;
}

/** A boost newer than this when a poll first shows it is news; older ones (a tab back from sleep) light nothing. */
export const IGNITE_FRESH_MS = 180_000;

/**
 * Which cards light up on this poll: a token with more TWIG than the last snapshot showed (a new boost, or a token new
 * to the lane), whose newest boost is still fresh. `prev` null = the first snapshot this view has seen: nothing lights.
 * A token that only moved up because another expired has no fresh boost and stays still.
 */
export function boostIgnitions(prev: ReadonlyMap<string, string> | null, items: readonly LaneTotals[], nowMs: number, freshMs = IGNITE_FRESH_MS): Set<string> {
  const out = new Set<string>();
  if (!prev) return out;
  for (const it of items) {
    const before = prev.get(it.token);
    const grew = before === undefined || BigInt(it.twig) > BigInt(before);
    const fresh = nowMs - Date.parse(it.last_at) <= freshMs;
    if (grew && fresh) out.add(it.token);
  }
  return out;
}

/** The lane as the dialog needs it: is it full, and what does the last place hold (raw TWIG in the window). */
export type LaneEntry = { full: boolean; cutoff: string | null };

/**
 * Whether a boost of `raw` brings a token with `current` TWIG in the window into the lane as it stands. A full lane
 * needs at least the last place's total (a tie goes to the newer boost). A token already in the lane stays in it.
 */
export function boostShowsNow(entry: LaneEntry, current: bigint, raw: bigint, inLane: boolean): boolean {
  if (inLane || !entry.full || entry.cutoff === null) return true;
  return current + raw >= BigInt(entry.cutoff);
}

/* ─────────────────────────────── views and clicks ─────────────────────────────── */

/**
 * The lane counts how often it is seen and its cards are clicked: each card shows its clicks, /admin shows them all,
 * and the ranking never reads them (boost-ui.test.ts). A click counts only while its token is in the lane, at the place
 * the server's lane gives it.
 */
export const BOOST_SOURCES = ["home", "base"] as const;
export type BoostSource = (typeof BOOST_SOURCES)[number];
/** One click per visitor, token and slot: a reload or a double click counts once. */
export const BOOST_CLICK_SLOT_MS = 30 * 60_000;
/** The periods /admin can read. */
export const BOOST_STATS_DAYS = [1, 7, 30] as const;
export type BoostStatsDays = (typeof BOOST_STATS_DAYS)[number];

/** What the lane's beacon reports: the lane came on screen, or a card was clicked. */
export type BoostSeen = { kind: "view"; source: BoostSource } | { kind: "click"; source: BoostSource; token: string };

/** A beacon body → what it reports (the token lowercased), or null when it is not one. Other fields are ignored. */
export function parseBoostSeen(body: unknown): BoostSeen | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.source !== "string" || !(BOOST_SOURCES as readonly string[]).includes(b.source)) return null;
  const source = b.source as BoostSource;
  if (b.kind === "view") return { kind: "view", source };
  if (b.kind === "click" && typeof b.token === "string" && /^0x[0-9a-fA-F]{40}$/.test(b.token)) return { kind: "click", source, token: b.token.toLowerCase() };
  return null;
}

/** A token's place in the lane as it stands now (1-based), or null when it is not in it: then a click counts nothing. */
export function boostPlace(lane: readonly string[], token: string): number | null {
  const i = lane.indexOf(token.toLowerCase());
  return i >= 0 ? i + 1 : null;
}

/** The start of the 30-minute slot a moment falls in (UTC). */
export function boostClickSlot(nowMs: number): string {
  return new Date(Math.floor(nowMs / BOOST_CLICK_SLOT_MS) * BOOST_CLICK_SLOT_MS).toISOString();
}

/** The hour a view is counted in (UTC). */
export function boostViewHour(nowMs: number): string {
  return new Date(Math.floor(nowMs / 3_600_000) * 3_600_000).toISOString();
}

/** Click rows are kept this long (each names a visitor of one day); /admin reads 30 days at most. Views are counts and stay. */
export const BOOST_CLICKS_KEEP_DAYS = 90;

/**
 * Whether a beacon came from one of the site's own pages. Browsers send Sec-Fetch-Site on every request and Origin on
 * every POST, so a page elsewhere that sends beacons from its own visitors' browsers (a text/plain beacon needs no CORS
 * preflight) is refused here. A request with neither header is not a browser; it could forge both, and the per-IP
 * limit is what holds it.
 */
export function boostBeaconSameOrigin(secFetchSite: string | null, origin: string | null, host: string | null): boolean {
  if (secFetchSite) return secFetchSite === "same-origin";
  if (origin) {
    try {
      return host !== null && new URL(origin).host === host;
    } catch {
      return false; // "null" (a sandboxed frame) or garbage
    }
  }
  return true;
}

export function isBoostStatsDays(v: unknown): v is BoostStatsDays {
  return typeof v === "number" && (BOOST_STATS_DAYS as readonly number[]).includes(v);
}

/** "4.2%": clicks per lane view; "–" before any view. */
export function boostClickRate(clicks: number, views: number): string {
  if (!(views > 0)) return "–";
  return `${((clicks / views) * 100).toFixed(1)}%`;
}

/** Clicks per 100K TWIG (the floor) burned for the token in the same period; null when nothing was burned in it. */
export function boostClicksPerFloor(clicks: number, twigRaw: string): number | null {
  const whole = Number(boostWholeOf(BigInt(twigRaw)));
  if (!(whole > 0)) return null;
  return (clicks * Number(BOOST_FLOOR_TWIG)) / whole;
}

/* ─────────────────────────────── moderation ─────────────────────────────── */

export const BOOST_MOD_ACTIONS = ["hide", "unhide"] as const;
export type BoostModAction = (typeof BOOST_MOD_ACTIONS)[number];
export function isBoostModAction(v: unknown): v is BoostModAction {
  return typeof v === "string" && (BOOST_MOD_ACTIONS as readonly string[]).includes(v);
}

/** The text an admin wallet signs to hide a token from the lane or show it again. Its own wording, so a posts signature never replays here. */
export function buildBoostModMessage(p: { action: BoostModAction; token: string; wallet: string; nonce: string; ts: number }): string {
  return [
    `openlaunch.lol boosted lane`,
    ``,
    `Action: ${p.action}`,
    `Token: ${BOOST_CHAIN}:${p.token.toLowerCase()}`,
    `Admin: ${p.wallet.toLowerCase()}`,
    `Nonce: ${p.nonce}`,
    `Issued: ${new Date(p.ts).toISOString()}`,
  ].join("\n");
}

/* ─────────────────────────────── words ─────────────────────────────── */

/** Every sentence the feature shows, in one place, so a test can hold them to the rules (no value talk). */
export const BOOST_COPY = {
  laneTitle: "Boosted",
  laneNote: "Paid in TWIG sent to 0x…dEaD. Not a ranking: the Live sort and Trending count outside wallets only.",
  laneEmpty: "Nothing is boosted right now. Any Base launch can be boosted with TWIG from its page.",
  what: "The Boosted lane shows the 5 tokens with the most TWIG sent for them in the last 24 hours. A boost counts toward that total for 24 hours. It does not change the Live sort or the Trending board, and it is not an endorsement.",
  tag: "The last digits of the amount name this token, so the transfer itself records what it boosted.",
  final: "The TWIG goes to 0x…dEaD. It cannot be undone or refunded, and nothing is paid to openlaunch or Twigpine.",
  hidden: "This token is not shown in the Boosted lane.",
  baseOnly: "Boosts are on Base only: TWIG exists only there.",
  how: "Anyone can boost any Base launch from its page, from 100,000 TWIG. Boosts on one token in the same 24 hours add up. When the lane is full, a token shows once its total passes the 5th place.",
  short: "The lane is full. This boost alone will not bring this token into it yet: the 5th place holds more. It still counts for 24 hours and adds up with any other boost.",
} as const;

/** The confirm button's words for an amount. */
export function boostConfirmLabel(whole: bigint): string {
  return `Send ${groupWhole(whole)} TWIG to 0x…dEaD`;
}
