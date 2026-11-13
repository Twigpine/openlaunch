/**
 * Season points, the pure half (node --test loads this directly; relative imports only).
 *
 * Points are reputation for launching and trading, recomputed from scratch from the chain index. Every rule is
 * built on two definitions that cost real money to fake:
 *
 *   real buyer  = a wallet whose FIRST buy of a token was ≥ $5 (valued at the trade's own hour), outside the sniper
 *                 window (the launch block + 3, and the first 12 seconds), that received the tokens of that buy itself
 *                 (a relayer or bundler a swap was credited to, or a router forwarding to someone else, is not a
 *                 buyer), and that is not the launcher, a fee recipient, a protocol address, a wallet that got $5 or
 *                 more of the token by transfer from the launcher or a recipient BEFORE its first buy (a transfer after
 *                 it, or dust, can never take a buyer's points away), or a wallet kept off points
 *   real holder = a real buyer with ≥ $5 (≥ $1 if their profile is points-eligible) of that first buy's lot still left,
 *                 at the token's steady price (the median of its last trade price at the cut-off, 12 h and 24 h
 *                 before it, so one block's pump or dump at the end moves nothing)
 *   counted holders = every eligible real holder, and unverified ones up to max(10, 2 × eligible): a crowd of fresh
 *                 wallets with no X account reaches no threshold and pays no creator past that
 *
 * "Held" is judged per buy, from the transfer history: every incoming transfer is a lot, and every outgoing one (a sell,
 * or a transfer out to any wallet) uses up the newest lots first. A buy is held while at least half of its own lot is
 * left. So a round trip uses up the lot it just bought, tokens sent in later by another wallet are new lots that cover
 * no earlier buy, and $5 passed from wallet to wallet counts for none of them. Moving tokens out counts as selling.
 *
 * Only tokens whose quote has a price count at all. Then:
 *
 *   Creator (any token the wallet launched; only activity inside the season counts)
 *     - each real holder whose first buy was in the season, a day or more ago: 30 if their profile is points-eligible,
 *       else 5; a week or more ago: half again. A holder counts once per creator (their best token), and a creator is
 *       paid for at most max(10, 2 × their eligible holders) unverified ones (the most valuable first).
 *     - 10 per $1 of fees on buys ≥ $5 by points-eligible outside traders, for each buy half of which has been held ever
 *       since (a round trip earns nothing); at most 50 per trader per creator per day
 *     - a token scores 0 if its creator moved tokens out during the season (a sell, or a transfer to any wallet, a
 *       side wallet that then sells included; burning is not moving out) and less than half of their own buys is
 *       left
 *     - of the tokens a wallet launched on one UTC day, only the best 3 count (ranked with the fee cap applied)
 *   Scout (traders)
 *     - one of the first 25 real buyers of a token that now has 50+ counted holders, buying in the season: 100, and 50
 *       more while still holding half of that first buy
 *     - 5 per token with 10+ counted holders that the wallet first bought in the season (a real buy) and still
 *       half-held a day later; at most 20 tokens per UTC day
 *     - 10 per $1 of fees paid on buys ≥ $5 of other people's tokens with 20+ counted holders (which takes at least 7
 *       eligible ones; the 5+ eligible check is kept but never decides alone), for each buy half of which has been
 *       held ever since; at most 200 a day
 *
 * Version 2 (seasons started on rules_version 2; score.RULES_V2) adds, on top of everything above:
 *   - in-app trading (bb_launch_swaps.via_app; appTag.ts): a held in-app buy earns 15 per $1 of fees instead of 10;
 *     an in-app sell earns 5 per $1 of fees on the share of it that sold the wallet's own in-season buys made a week
 *     or more before (LIFO, so a round trip never qualifies). Per trader per day: min(300, min(200, plain buys) +
 *     in-app buys + sells). Same token gates as scout fees. The tag is public, so the bonus stays small and capped
 *   - vesting: a buy half held for a week keeps its fee points (creator and scout) after it is sold
 *   - creator volume milestones per token: outside trades with capital at risk (held buys, sells of buys a week old;
 *     a round trip counts for nothing) at their own hour's value, each trader counted for at most
 *     $1,000 a day across one creator's tokens ($100 without a qualifying profile). $10k / $50k / $250k / $1M of that
 *     with 10 / 25 / 75 / 200 distinct eligible traders on the token add 100 / 400 / 1,500 / 4,000 (6,000 at most),
 *     with 50+ counted holders, on a token that is not a dump; part of the token's value in the best-3-per-day pick
 *
 * Only points-eligible wallets rank; everyone else sees what is waiting for them.
 */

/**
 * Version 1: every season started before rules had versions, and the base every later version builds on. A season
 * keeps the version it was started with (bb_seasons.rules_version), so a bonus added later never changes the standings
 * of a season already running. Fixes to how version 1 judges buyers, holders and prices (2026-11-11: counted holders,
 * linked wallets only from before a first buy, trade-time USD, the steady price) are part of version 1 itself and
 * rescore a running season on its next run: mostly they take farmed points away, but a wallet wrongly treated as an
 * insider, or a trade worth more at its own hour, can gain.
 */
export const RULES_V1 = {
  sniperBlocks: 3,
  sniperMs: 12_000,
  minTradeUsd: 5,
  holderMinUsd: 5,
  verifiedHolderMinUsd: 1,
  verifiedHolder: 30,
  holder: 5,
  weekBonus: 0.5,
  creatorFeePointsPerUsd: 10,
  creatorFeeCapPerTraderDay: 50,
  bestTokensPerDay: 3,
  early: 100,
  earlyStillHolding: 50,
  earlyFirstBuyers: 25,
  earlyHoldersTarget: 50,
  hold: 5,
  holdTokensPerDay: 20,
  scoutFeePointsPerUsd: 10,
  scoutFeeCapPerDay: 200,
  scoutFeeMinHolders: 20,
  scoutFeeMinEligibleHolders: 5,
  // counted holders: unverified real holders count up to max(unverifiedFree, unverifiedPerVerified × eligible ones)
  unverifiedFree: 10,
  unverifiedPerVerified: 2,
  holdMinHolders: 10,
  // tokens from the launcher or a fee recipient before a wallet's first buy make it an insider from this much on
  linkMinUsd: 5,
  // points-eligible profile: X-verified on an account this old with this many followers
  eligibleMinAgeDays: 30,
  eligibleMinFollowers: 20,
} as const;

/** Version 2's bonuses (score.ts header, "Version 2"). */
export type BonusRules = {
  /** points per $1 of fees on an in-app buy (10 elsewhere) */
  appFeePointsPerUsd: number;
  /** a trader's daily fee points with in-app trades: plain buys still stop at scoutFeeCapPerDay, in-app ones fill the rest */
  scoutFeeCapPerDayApp: number;
  /** points per $1 of fees on an in-app sell of tokens the wallet bought in the season at least `sellMinLotAgeMs` before */
  sellFeePointsPerUsd: number;
  sellMinLotAgeMs: number;
  /** a buy half held this long keeps its fee points (creator and scout) after it is sold */
  buyVestMs: number;
  /** a creator's qualified volume: per trader per UTC day across all their tokens, at most this much */
  volumeTraderCapUsd: number;
  volumeUnverifiedTraderCapUsd: number;
  /** a token earns volume milestones only with this many counted holders */
  volumeMinHolders: number;
  /** cumulative: each one reached (qualified volume and distinct eligible traders on the token) adds its points */
  volumeTiers: readonly { usd: number; pts: number; traders: number }[];
};
/**
 * The rules one season scores on: every version-1 field as a number (not its version-1 value, so a version or a
 * test can change one), plus the bonuses from version 2 on.
 */
export type Rules = { readonly [K in keyof typeof RULES_V1]: number } & { readonly bonus?: BonusRules };
/** The rules every page describes where all versions agree (eligibility, real buyers): version 1's. */
export const RULES: Rules = RULES_V1;

/** Version 2: version 1 plus in-app trading points, a week's vesting on buys, and creator volume milestones. */
export const RULES_V2: Rules = {
  ...RULES_V1,
  bonus: {
    appFeePointsPerUsd: 15,
    scoutFeeCapPerDayApp: 300,
    sellFeePointsPerUsd: 5,
    sellMinLotAgeMs: 7 * 86_400_000,
    buyVestMs: 7 * 86_400_000,
    volumeTraderCapUsd: 1_000,
    volumeUnverifiedTraderCapUsd: 100,
    volumeMinHolders: 50,
    volumeTiers: [
      { usd: 10_000, pts: 100, traders: 10 },
      { usd: 50_000, pts: 400, traders: 25 },
      { usd: 250_000, pts: 1_500, traders: 75 },
      { usd: 1_000_000, pts: 4_000, traders: 200 },
    ],
  },
};
/** The version a new season starts on. */
export const LATEST_RULES_VERSION = 2;
/** The rules of a version (an unknown one scores on version 1). */
export function rulesFor(version: number | null | undefined): Rules {
  switch (version) {
    case 2:
      return RULES_V2;
    default:
      return RULES_V1;
  }
}

const DAY = 86_400_000;

export type ScoreLaunch = {
  key: string; // chain:token
  launcher: string;
  recipients: readonly string[];
  launchBlock: number;
  launchTime: number; // ms
  lpFee: number; // pips (10_000 = 1%)
  quoteDecimals: number;
  quoteUsd: number | null; // USD per whole quote unit; null = unpriced → the token is out of scoring
  tokenUsd: number | null; // USD per whole token now; null → out of scoring
};
/** `usd`: the trade's value at its own hour (bb_launch_swaps.usd); missing or null → the quote's price in this run. */
/** `app`: made in the app (bb_launch_swaps.via_app; appTag.ts). */
export type ScoreSwap = { key: string; trader: string; isBuy: boolean; quoteRaw: bigint; quoteFeeRaw?: bigint; tokenRaw: bigint; block: number; logIndex: number; time: number; tx: string; usd?: number | null; app?: boolean };
/** A wallet's first buy of a token, all-time (its rank among real buyers decides "early"). */
export type FirstBuy = { key: string; wallet: string; block: number; logIndex: number; time: number; quoteRaw: bigint; tokenRaw: bigint; tx: string; usd?: number | null };
/** One transfer of a token from its launcher or a fee recipient to `wallet`. */
export type LinkedTransfer = { wallet: string; block: number; logIndex: number; raw: bigint };

export type ScoreInput = {
  seasonStart: number;
  seasonEnd: number;
  now: number;
  launches: readonly ScoreLaunch[];
  /** swaps inside the season, any order */
  swaps: readonly ScoreSwap[];
  firstBuys: readonly FirstBuy[];
  /**
   * every balance change (raw, 18 decimals) of buyers and launchers of the tokens in scope, from the transfer history;
   * `burn` marks tokens sent to a burn address (0x0, 0x…dead)
   */
  moves: readonly { key: string; wallet: string; block: number; logIndex: number; tx: string; delta: bigint; burn?: boolean }[];
  /** the launcher's own buys of each token, all-time (transaction + tokens bought) */
  launcherBuys: ReadonlyMap<string, readonly { tx: string; tokenRaw: bigint }[]>;
  /** per token: every transfer of it from the launcher or a fee recipient (only those before a wallet's first buy link it) */
  linked: ReadonlyMap<string, readonly LinkedTransfer[]>;
  /** protocol addresses (pool manager, routers, locker, factory, zero, dead) */
  system: ReadonlySet<string>;
  eligible: ReadonlySet<string>;
  /** kept off points by an admin: never points, never anyone's buyer, holder or trader */
  flagged: ReadonlySet<string>;
  /**
   * per chain (the key's prefix, "base"): the first block of the season. Transfers carry blocks, not times, so this is
   * what tells a creator's in-season outflows from earlier ones. A chain missing here counts only swap sells.
   */
  seasonStartBlocks: ReadonlyMap<string, number>;
  /**
   * (version 2) more exact (time, block) points that place transfers in time for the week's vesting: the season's
   * swaps not credited to anyone yet. Never scored as trades.
   */
  timelinePoints?: readonly { key: string; block: number; time: number }[];
};

/** Version 2 adds `volumeUsd` / `volumePts` (creator) and `appFeesUsd` / `sellFeesUsd` (scout); older rows lack them. */
export type CreatorBreakdown = { tokens: number; verifiedHolders: number; holders: number; feesUsd: number; dumped: number; volumeUsd?: number; volumePts?: number };
export type ScoutBreakdown = { early: number; holds: number; feesUsd: number; appFeesUsd?: number; sellFeesUsd?: number };
export type WalletScore = { wallet: string; creator: number; scout: number; total: number; creatorWhy: CreatorBreakdown; scoutWhy: ScoutBreakdown };
export type ScoreResult = { wallets: Map<string, WalletScore>; realHolders: Map<string, number> };

/** A raw token amount in whole units. */
const units = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;
/** The UTC day number of a moment (for per-day caps and the best-3-per-launch-day rule). */
const utcDay = (ms: number) => Math.floor(ms / DAY);

/** Score one season from the chain index (pure): real buyers and holders, creator and scout points, caps, and the why behind each. */
export function scoreSeason(input: ScoreInput, rules: Rules = RULES_V1): ScoreResult {
  const R = rules;
  const end = Math.min(input.now, input.seasonEnd);
  // only priced tokens take part: an unpriced quote has no dollar floor to hold anything to
  const launches = new Map(input.launches.filter((l) => l.quoteUsd !== null && l.tokenUsd !== null && l.quoteUsd > 0 && l.tokenUsd > 0).map((l) => [l.key, l]));
  const wallets = new Map<string, WalletScore>();
  const get = (w: string) => {
    let s = wallets.get(w);
    if (!s) {
      s = { wallet: w, creator: 0, scout: 0, total: 0, creatorWhy: { tokens: 0, verifiedHolders: 0, holders: 0, feesUsd: 0, dumped: 0 }, scoutWhy: { early: 0, holds: 0, feesUsd: 0 } };
      wallets.set(w, s);
    }
    return s;
  };
  const sniper = (l: ScoreLaunch, block: number, time: number) => block <= l.launchBlock + R.sniperBlocks || time - l.launchTime < R.sniperMs;
  const quoteUsd = (l: ScoreLaunch, raw: bigint) => units(raw, l.quoteDecimals) * (l.quoteUsd as number);
  /** A trade's USD value at its own hour when it was stored, else at this run's quote price. */
  const tradeUsd = (l: ScoreLaunch, t: { quoteRaw: bigint; usd?: number | null }) => (typeof t.usd === "number" && Number.isFinite(t.usd) ? t.usd : quoteUsd(l, t.quoteRaw));
  // Use the hook's rounded quote fee at the same historical price as the trade.
  const feeUsd = (l: ScoreLaunch, s: ScoreSwap) => s.quoteFeeRaw === undefined
    ? (tradeUsd(l, s) * l.lpFee) / 1_000_000
    : s.quoteRaw > 0n ? tradeUsd(l, s) * (Number(s.quoteFeeRaw) / Number(s.quoteRaw)) : quoteUsd(l, s.quoteFeeRaw);
  const tokenUsd = (l: ScoreLaunch, raw: bigint) => units(raw, 18) * (l.tokenUsd as number);
  const inSeason = (t: number) => t >= input.seasonStart && t < end;
  // linked wallets: $5 or more of the token from the launcher or a fee recipient BEFORE the wallet's first buy. A
  // transfer after it (or dust) changes nothing, so a launcher cannot take a buyer's points away by sending them tokens
  const firstAt = new Map<string, { block: number; logIndex: number }>();
  for (const f of input.firstBuys) firstAt.set(`${f.key}|${f.wallet}`, f);
  const linked = new Map<string, Set<string>>();
  for (const [key, list] of input.linked) {
    const l = launches.get(key);
    if (!l) continue;
    const before = new Map<string, bigint>();
    for (const t of list) {
      const f = firstAt.get(`${key}|${t.wallet}`);
      if (f && (t.block > f.block || (t.block === f.block && t.logIndex > f.logIndex))) continue;
      before.set(t.wallet, (before.get(t.wallet) ?? 0n) + t.raw);
    }
    const set = new Set<string>();
    for (const [w, raw] of before) if (tokenUsd(l, raw) >= R.linkMinUsd) set.add(w);
    linked.set(key, set);
  }
  const insider = (l: ScoreLaunch, w: string) => w === l.launcher || l.recipients.includes(w) || input.system.has(w) || input.flagged.has(w) || (linked.get(l.key)?.has(w) ?? false);
  // lots per (token, wallet): each incoming transfer is a lot; each outgoing one uses up the newest lots first (LIFO).
  // A lot only ever shrinks, so what is left of it at the end is the least it ever held. Linear in the moves.
  const lotsByTx = new Map<string, bigint>(); // `${key}|${wallet}|${tx}` → what is left of the lots that tx brought in
  const receivedByTx = new Map<string, bigint>(); // `${key}|${wallet}|${tx}` → what that tx brought in at all
  // (version 2) each lot's outflows by block, to tell what was left of it at a moment; and what each outflow used up
  type Lot = { tx: string; size: bigint; left: bigint; outs: { block: number; take: bigint }[] };
  const history = R.bonus !== undefined; // version 1 needs none of it
  const lotsOfTx = new Map<string, Lot[]>(); // `${key}|${wallet}|${tx}` → the lots that tx brought in
  const usedBy = new Map<string, { lotTx: string; take: bigint }[]>(); // `${key}|${wallet}|${outTx}` → the lots it used up
  {
    const byPair = new Map<string, Map<string, { block: number; logIndex: number; tx: string; delta: bigint }>>();
    for (const m of input.moves) {
      const k = `${m.key}|${m.wallet}`;
      const at = `${m.block}:${m.logIndex}`;
      const byAt = byPair.get(k) ?? new Map();
      const cur = byAt.get(at);
      byAt.set(at, { block: m.block, logIndex: m.logIndex, tx: m.tx, delta: (cur?.delta ?? 0n) + m.delta }); // a self-transfer nets to 0
      byPair.set(k, byAt);
    }
    for (const [k, byAt] of byPair) {
      const stack: Lot[] = [];
      const all: Lot[] = [];
      for (const m of [...byAt.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
        if (m.delta > 0n) {
          const lot: Lot = { tx: m.tx, size: m.delta, left: m.delta, outs: [] };
          stack.push(lot);
          all.push(lot);
          receivedByTx.set(`${k}|${m.tx}`, (receivedByTx.get(`${k}|${m.tx}`) ?? 0n) + m.delta);
        } else if (m.delta < 0n) {
          let out = -m.delta;
          while (out > 0n && stack.length) {
            const top = stack[stack.length - 1];
            const take = top.left < out ? top.left : out;
            top.left -= take;
            out -= take;
            if (history) {
              top.outs.push({ block: m.block, take });
              const used = usedBy.get(`${k}|${m.tx}`);
              if (used) used.push({ lotTx: top.tx, take });
              else usedBy.set(`${k}|${m.tx}`, [{ lotTx: top.tx, take }]);
            }
            if (top.left === 0n) stack.pop();
          }
        }
      }
      for (const lot of all) {
        lotsByTx.set(`${k}|${lot.tx}`, (lotsByTx.get(`${k}|${lot.tx}`) ?? 0n) + lot.left);
        if (!history) continue;
        const lots = lotsOfTx.get(`${k}|${lot.tx}`);
        if (lots) lots.push(lot);
        else lotsOfTx.set(`${k}|${lot.tx}`, [lot]);
      }
    }
  }
  /** What is left of the tokens a transaction brought into a wallet (matched by transaction, not log order). */
  const leftOf = (key: string, w: string, tx: string) => lotsByTx.get(`${key}|${w}|${tx}`) ?? 0n;
  /** At least half of a buy's own lot left. */
  const halfLeft = (key: string, w: string, tx: string, boughtRaw: bigint) => {
    const left = leftOf(key, w, tx);
    return left > 0n && left * 2n >= boughtRaw;
  };

  /** What was left of the lots a transaction brought in after every outflow up to and including `block`. */
  const leftAt = (key: string, w: string, tx: string, block: number) => {
    let left = 0n;
    for (const lot of lotsOfTx.get(`${key}|${w}|${tx}`) ?? []) left += lot.size - lot.outs.reduce((a, o) => (o.block <= block ? a + o.take : a), 0n);
    return left;
  };
  // (version 2) where a moment falls among the blocks, per chain, from the trades' own exact (time, block) pairs
  // (transfers carry blocks, not times): the block of the last trade at or before the moment. A trade is never placed
  // on the wrong side of it (a sell after the moment is in a later block), and no moment ever reaches past the trades
  // known. A bare transfer between that trade and the next is taken as after the moment: in the holder's favour, which
  // cannot be farmed (the tokens moved out and still unsold sit in the token as long as they would have)
  const timeline = new Map<string, { time: number; block: number }[]>();
  for (const t of history ? [...input.swaps, ...input.firstBuys, ...(input.timelinePoints ?? [])] : []) {
    const c = t.key.split(":")[0];
    const list = timeline.get(c) ?? [];
    list.push({ time: t.time, block: t.block });
    timeline.set(c, list);
  }
  for (const list of timeline.values()) list.sort((a, b) => a.time - b.time || a.block - b.block);
  const lastBlockAt = (key: string, ms: number) => {
    const list = timeline.get(key.split(":")[0]) ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].time <= ms) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? Number.NEGATIVE_INFINITY : list[lo - 1].block; // before every trade known: no outflow yet
  };

  /** The wallet received at least half of what a buy bought, in that buy's own transaction. */
  const received = (key: string, w: string, tx: string, boughtRaw: bigint) => (receivedByTx.get(`${key}|${w}|${tx}`) ?? 0n) * 2n >= boughtRaw;

  // real buyers per token, in buy order
  const realBuyers = new Map<string, FirstBuy[]>();
  for (const f of input.firstBuys) {
    const l = launches.get(f.key);
    if (!l || insider(l, f.wallet) || sniper(l, f.block, f.time) || tradeUsd(l, f) < R.minTradeUsd) continue;
    if (!received(f.key, f.wallet, f.tx, f.tokenRaw)) continue; // the tokens went to someone else: not this wallet's buy
    const list = realBuyers.get(f.key) ?? [];
    list.push(f);
    realBuyers.set(f.key, list);
  }
  for (const list of realBuyers.values()) list.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex || a.time - b.time);

  // real holders per token (real buyers still holding enough)
  const realHolders = new Map<string, FirstBuy[]>();
  for (const [key, list] of realBuyers) {
    const l = launches.get(key)!;
    const held = list.filter((f) => tokenUsd(l, leftOf(key, f.wallet, f.tx)) >= (input.eligible.has(f.wallet) ? R.verifiedHolderMinUsd : R.holderMinUsd));
    realHolders.set(key, held);
  }
  const eligibleHolders = new Map<string, number>();
  for (const [key, list] of realHolders) eligibleHolders.set(key, list.filter((f) => input.eligible.has(f.wallet)).length);
  /** Counted holders of a token: every eligible one, and unverified ones up to the allowance (countedHolders). */
  const holderCount = (key: string) => {
    const e = eligibleHolders.get(key) ?? 0;
    return countedHolders(e, (realHolders.get(key)?.length ?? 0) - e, R);
  };

  // the season's outside trades (≥ $5, outside the sniper window), and what each creator sold
  const outside: ScoreSwap[] = [];
  const creatorSold = new Set<string>();
  for (const s of input.swaps) {
    const l = launches.get(s.key);
    if (!l || !inSeason(s.time)) continue;
    if (s.trader === l.launcher && !s.isBuy) creatorSold.add(s.key);
    if (insider(l, s.trader) || sniper(l, s.block, s.time) || tradeUsd(l, s) < R.minTradeUsd) continue;
    outside.push(s);
  }
  // in chain order, so a daily cap is used up the same way on every run (the database returns rows in any order)
  outside.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key) || a.block - b.block || a.logIndex - b.logIndex);

  // net buying: a buy earns fee points only if at least half of it has been held every moment since, so a round trip
  // (the fees coming back to a farmer's own token) earns nothing and washing ties up real capital for the season.
  // From version 2, a buy half held for a week (buyVestMs) keeps them after it is sold: capital still sits a week
  const B = R.bonus;
  const heldMemo = new Map<ScoreSwap, boolean>(); // creator fees, volume and scout fees each ask about the same buys
  const heldBuy = (s: ScoreSwap) => {
    const hit = heldMemo.get(s);
    if (hit !== undefined) return hit;
    let held: boolean;
    if (!B || end - s.time < B.buyVestMs) held = halfLeft(s.key, s.trader, s.tx, s.tokenRaw);
    else {
      const left = leftAt(s.key, s.trader, s.tx, lastBlockAt(s.key, s.time + B.buyVestMs));
      held = left > 0n && left * 2n >= s.tokenRaw;
    }
    heldMemo.set(s, held);
    return held;
  };
  // (version 2) the share of a sell that sold the wallet's own in-season buys made a week or more before it (LIFO:
  // a round trip uses up the lot it just bought, so it never qualifies). Worked out for the whole transaction (what it
  // sold of week-old buys over everything it moved out) and given to each of its sell swaps alike: a sale split into
  // many swaps shares one old lot between them instead of each claiming all of it
  const buyTime = new Map<string, number>(); // `${key}|${wallet}|${tx}` → when an in-season buy was made
  for (const s of input.swaps) if (s.isBuy && inSeason(s.time)) buyTime.set(`${s.key}|${s.trader}|${s.tx}`, s.time);
  const agedSellShare = (s: ScoreSwap) => {
    if (!B || s.isBuy || s.tokenRaw <= 0n) return 0;
    let aged = 0n;
    let total = 0n;
    for (const u of usedBy.get(`${s.key}|${s.trader}|${s.tx}`) ?? []) {
      total += u.take;
      const at = buyTime.get(`${s.key}|${s.trader}|${u.lotTx}`);
      if (at !== undefined && s.time - at >= B.sellMinLotAgeMs) aged += u.take;
    }
    return total > 0n ? Math.min(1, Number((aged * 1_000_000n) / total) / 1_000_000) : 0;
  };

  // ── creator points ──
  type TokenCreator = { l: ScoreLaunch; holders: { wallet: string; pts: number; eligible: boolean }[]; fees: { trader: string; day: number; usd: number }[]; dumped: boolean; volume: { pts: number; usd: number } };
  const perToken = new Map<string, TokenCreator>();
  const ensure = (l: ScoreLaunch) => {
    let t = perToken.get(l.key);
    if (!t) {
      t = { l, holders: [], fees: [], dumped: false, volume: { pts: 0, usd: 0 } };
      perToken.set(l.key, t);
    }
    return t;
  };
  for (const [key, list] of realHolders) {
    const l = launches.get(key)!;
    for (const f of list) {
      if (!inSeason(f.time) || end - f.time < DAY) continue; // gained this season, held a day
      const eligible = input.eligible.has(f.wallet);
      const pts = (eligible ? R.verifiedHolder : R.holder) * (end - f.time >= 7 * DAY ? 1 + R.weekBonus : 1);
      ensure(l).holders.push({ wallet: f.wallet, pts, eligible });
    }
  }
  for (const s of outside) {
    // fees count only on buys by points-eligible traders who are net buyers: wash trades need real accounts and capital
    if (!s.isBuy || !input.eligible.has(s.trader) || !heldBuy(s)) continue;
    const l = launches.get(s.key)!;
    const fee = feeUsd(l, s);
    if (fee > 0) ensure(l).fees.push({ trader: s.trader, day: utcDay(s.time), usd: fee });
  }
  // the creator's in-season outflows of each token: a sell, or tokens moved to any other wallet (one that then sells
  // included; a burn is not one), told from earlier ones by the season's first block on that chain
  const creatorOut = new Set(creatorSold);
  for (const m of input.moves) {
    const l = launches.get(m.key);
    if (!l || m.wallet !== l.launcher || m.delta >= 0n || m.burn) continue;
    const from = input.seasonStartBlocks.get(m.key.split(":")[0]);
    if (from !== undefined && m.block >= from) creatorOut.add(m.key);
  }
  /**
   * A dump: tokens moved out during the season and less than half of the creator's own buys is left (fee tokens that
   * came in after the buys are used up first, so selling those is not one).
   */
  const dumpedMemo = new Map<string, boolean>();
  const dumped = (l: ScoreLaunch) => {
    const hit = dumpedMemo.get(l.key);
    if (hit !== undefined) return hit;
    const buys = input.launcherBuys.get(l.key) ?? [];
    const bought = buys.reduce((a, b) => a + b.tokenRaw, 0n);
    const left = buys.reduce((a, b) => a + leftOf(l.key, l.launcher, b.tx), 0n);
    const d = bought > 0n && creatorOut.has(l.key) && left * 2n < bought;
    dumpedMemo.set(l.key, d);
    return d;
  };
  // (version 2) volume milestones: each token's qualified volume is its outside trades with capital at risk, at their
  // own hour's value: buys still held (heldBuy: half held throughout, or for a week), and the share of sells that sold
  // the trader's own buys made a week or more before (so a round trip counts for nothing on either side); each trader
  // counted for at most $1,000 a day across all of one creator's tokens ($100 without a qualifying profile). A
  // milestone needs that volume, that many distinct eligible traders on the token, and 50 counted holders
  if (B) {
    const used = new Map<string, number>(); // `${creator}|${trader}|${day}` → qualified volume counted so far
    const volume = new Map<string, { usd: number; traders: Set<string> }>();
    const dumpedKeys = new Set<string>();
    for (const l of launches.values()) if (dumped(l)) dumpedKeys.add(l.key);
    for (const s of outside) {
      const l = launches.get(s.key)!;
      if (dumpedKeys.has(s.key)) continue; // a dumped token scores nothing, and uses up no trader's allowance
      const eligible = input.eligible.has(s.trader);
      const atRisk = s.isBuy ? (heldBuy(s) ? 1 : 0) : agedSellShare(s);
      if (atRisk <= 0) continue;
      const k = `${l.launcher}|${s.trader}|${utcDay(s.time)}`;
      const add = Math.min(tradeUsd(l, s) * atRisk, (eligible ? B.volumeTraderCapUsd : B.volumeUnverifiedTraderCapUsd) - (used.get(k) ?? 0));
      if (add <= 0) continue;
      used.set(k, (used.get(k) ?? 0) + add);
      const v = volume.get(s.key) ?? { usd: 0, traders: new Set<string>() };
      v.usd += add;
      if (eligible) v.traders.add(s.trader);
      volume.set(s.key, v);
    }
    for (const [key, v] of volume) {
      if (holderCount(key) < B.volumeMinHolders) continue;
      let pts = 0;
      for (const tier of B.volumeTiers) {
        if (v.usd < tier.usd || v.traders.size < tier.traders) break;
        pts += tier.pts;
      }
      if (pts > 0) ensure(launches.get(key)!).volume = { pts, usd: v.usd };
    }
  }
  for (const t of perToken.values()) if (dumped(t.l)) t.dumped = true;
  // per creator: each holder once (their best token), fees capped per trader per day, best 3 tokens per launch day
  const byCreator = new Map<string, TokenCreator[]>();
  for (const t of perToken.values()) {
    if (input.flagged.has(t.l.launcher)) continue;
    const list = byCreator.get(t.l.launcher) ?? [];
    list.push(t);
    byCreator.set(t.l.launcher, list);
  }
  for (const [creator, tokens] of byCreator) {
    const s = get(creator);
    const live = tokens.filter((t) => !t.dumped);
    s.creatorWhy.dumped = tokens.length - live.length;
    // each holder once, on the token where they are worth the most among `pool`
    type Assigned = Map<string, { t: TokenCreator; pts: number; eligible: boolean }>;
    const assign = (pool: readonly TokenCreator[]): Assigned => {
      const best: Assigned = new Map();
      for (const t of pool) {
        for (const h of t.holders) {
          const cur = best.get(h.wallet);
          if (!cur || h.pts > cur.pts) best.set(h.wallet, { t, pts: h.pts, eligible: h.eligible });
        }
      }
      return best;
    };
    /** This creator's room for unverified holders: max(10, 2 × the eligible holders in `best`). */
    const roomOf = (best: Assigned) => {
      let n = 0;
      for (const h of best.values()) if (h.eligible) n++;
      return unverifiedAllowance(n, R);
    };
    /** Fee points of one token, at most 50 per trader per day, counting what `used` already holds for this creator. */
    const feePoints = (t: TokenCreator, used: Map<string, number>) => {
      let pts = 0;
      let usd = 0;
      for (const f of t.fees) {
        const k = `${f.trader}|${f.day}`;
        const already = used.get(k) ?? 0;
        const p = Math.min(f.usd * R.creatorFeePointsPerUsd, R.creatorFeeCapPerTraderDay - already);
        if (p <= 0) continue;
        used.set(k, already + p);
        pts += p;
        usd += f.usd;
      }
      return { pts, usd };
    };
    // the best 3 tokens of each launch day, picked one at a time by what each ADDS: its holders (each on their best
    // token) and its fees with the per-trader-per-day cap applied after what the tokens already picked used of it (an
    // uncapped estimate let one big fee payer push out a token with real holders; three tokens sharing one trader's
    // cap are worth one cap, not three)
    // (each token's unverified holders count up to the creator's room in this estimate: a crowd of fresh wallets on
    // one token is worth no more than the room, so it cannot push out a token with eligible holders; capping the
    // whole creator here instead would cut holders by wallet order and could keep the wrong tokens)
    const firstPass = new Map<TokenCreator, number>();
    const liveBest = assign(live);
    const liveRoom = roomOf(liveBest);
    const unverifiedPts = new Map<TokenCreator, number[]>();
    for (const [, h] of liveBest) {
      if (h.eligible) firstPass.set(h.t, (firstPass.get(h.t) ?? 0) + h.pts);
      else unverifiedPts.set(h.t, [...(unverifiedPts.get(h.t) ?? []), h.pts]);
    }
    for (const [t, pts] of unverifiedPts) firstPass.set(t, (firstPass.get(t) ?? 0) + pts.sort((a, b) => b - a).slice(0, liveRoom).reduce((a, b) => a + b, 0));
    const byDay = new Map<number, TokenCreator[]>();
    for (const t of live) {
      const d = utcDay(t.l.launchTime);
      byDay.set(d, [...(byDay.get(d) ?? []), t]);
    }
    const kept: TokenCreator[] = [];
    const added = new Map<TokenCreator, number>();
    for (const list of byDay.values()) {
      const left = [...list].sort((a, b) => a.l.key.localeCompare(b.l.key));
      const used = new Map<string, number>();
      for (let picked = 0; picked < R.bestTokensPerDay && left.length; picked++) {
        let best = 0;
        let bestValue = -1;
        left.forEach((t, i) => {
          const v = (firstPass.get(t) ?? 0) + feePoints(t, new Map(used)).pts + t.volume.pts;
          if (v > bestValue) [best, bestValue] = [i, v];
        });
        const [t] = left.splice(best, 1);
        feePoints(t, used);
        added.set(t, bestValue);
        kept.push(t);
      }
    }
    kept.sort((a, b) => (added.get(b) ?? 0) - (added.get(a) ?? 0) || a.l.key.localeCompare(b.l.key));
    // the count: each holder on their best kept token (a holder whose favourite was cut still counts on another), the
    // unverified ones past this creator's room not paid at all (the most valuable kept, then by wallet), and fees with
    // the cap shared across all of this creator's kept tokens
    const holderBest = assign(kept);
    const room = roomOf(holderBest);
    const unverified = [...holderBest].filter(([, h]) => !h.eligible).sort(([wa, a], [wb, b]) => b.pts - a.pts || wa.localeCompare(wb));
    for (const [wallet] of unverified.slice(room)) holderBest.delete(wallet);
    const value = new Map<TokenCreator, number>();
    for (const [, h] of holderBest) value.set(h.t, (value.get(h.t) ?? 0) + h.pts);
    const feeUsed = new Map<string, number>();
    const counted = new Set<string>();
    for (const t of kept) {
      const fees = feePoints(t, feeUsed);
      const v = (value.get(t) ?? 0) + fees.pts + t.volume.pts;
      if (v <= 0) continue;
      s.creator += v;
      s.creatorWhy.tokens++;
      s.creatorWhy.feesUsd += fees.usd;
      if (t.volume.pts > 0) {
        s.creatorWhy.volumePts = (s.creatorWhy.volumePts ?? 0) + t.volume.pts;
        s.creatorWhy.volumeUsd = (s.creatorWhy.volumeUsd ?? 0) + t.volume.usd;
      }
      for (const [wallet, h] of holderBest) {
        if (h.t !== t || counted.has(wallet)) continue;
        counted.add(wallet);
        if (h.eligible) s.creatorWhy.verifiedHolders++;
        else s.creatorWhy.holders++;
      }
    }
  }

  // ── scout points ──
  for (const [key, list] of realBuyers) {
    if (holderCount(key) < R.earlyHoldersTarget) continue;
    for (const f of list.slice(0, R.earlyFirstBuyers)) {
      if (!inSeason(f.time)) continue;
      const s = get(f.wallet);
      s.scout += R.early + (halfLeft(key, f.wallet, f.tx, f.tokenRaw) ? R.earlyStillHolding : 0);
      s.scoutWhy.early++;
    }
  }
  // holds: a token the wallet FIRST bought in the season (its first buy ever was a real buy, in the season), half of
  // that buy held a day later; a later buy of a token held from before the season, or after a first buy that was not
  // a real one (a sniper, under $5), earns nothing; nor does a token with under 10 counted holders (a farmer's own
  // token nobody else holds)
  const firstInSeason: FirstBuy[] = [];
  for (const [key, list] of realBuyers) {
    if (holderCount(key) < R.holdMinHolders) continue;
    for (const f of list) if (inSeason(f.time)) firstInSeason.push(f);
  }
  const holdsPerDay = new Map<string, number>();
  for (const f of firstInSeason.sort((a, b) => a.time - b.time || a.block - b.block || a.logIndex - b.logIndex)) {
    if (end - f.time < DAY || !halfLeft(f.key, f.wallet, f.tx, f.tokenRaw)) continue;
    const dayKey = `${f.wallet}|${utcDay(f.time)}`;
    const n = holdsPerDay.get(dayKey) ?? 0;
    if (n >= R.holdTokensPerDay) continue;
    holdsPerDay.set(dayKey, n + 1);
    const w = get(f.wallet);
    w.scout += R.hold;
    w.scoutWhy.holds++;
  }
  const feeGate = (key: string) => holderCount(key) >= R.scoutFeeMinHolders && (eligibleHolders.get(key) ?? 0) >= R.scoutFeeMinEligibleHolders;
  if (!B) {
    const scoutFeeUsed = new Map<string, number>();
    for (const s of outside) {
      if (!s.isBuy || !heldBuy(s)) continue;
      if (!feeGate(s.key)) continue;
      const l = launches.get(s.key)!;
      const fee = feeUsd(l, s);
      if (fee <= 0) continue;
      const k = `${s.trader}|${utcDay(s.time)}`;
      const used = scoutFeeUsed.get(k) ?? 0;
      const pts = Math.min(fee * R.scoutFeePointsPerUsd, R.scoutFeeCapPerDay - used);
      if (pts <= 0) continue;
      scoutFeeUsed.set(k, used + pts);
      const w = get(s.trader);
      w.scout += pts;
      w.scoutWhy.feesUsd += fee;
    }
  } else {
    // version 2: per trader per UTC day, plain buys earn 10 a $1 of fees up to 200; in-app buys 15 a $1 and in-app
    // sells of tokens bought in the season a week or more before 5 a $1, filling the day up to 300 together:
    // min(300, min(200, plain) + in-app buys + sells), the same whatever order the trades came in
    const days = new Map<string, { trader: string; plain: number; app: number; sell: number; feesUsd: number; appUsd: number; sellUsd: number }>();
    for (const s of outside) {
      if (!feeGate(s.key)) continue;
      const l = launches.get(s.key)!;
      const fee = feeUsd(l, s);
      if (fee <= 0) continue;
      const k = `${s.trader}|${utcDay(s.time)}`;
      const d = days.get(k) ?? { trader: s.trader, plain: 0, app: 0, sell: 0, feesUsd: 0, appUsd: 0, sellUsd: 0 };
      if (s.isBuy) {
        if (!heldBuy(s)) continue;
        if (s.app) {
          d.app += fee * B.appFeePointsPerUsd;
          d.appUsd += fee;
        } else d.plain += fee * R.scoutFeePointsPerUsd;
        d.feesUsd += fee;
      } else {
        if (!s.app) continue;
        const share = agedSellShare(s);
        if (share <= 0) continue;
        d.sell += fee * share * B.sellFeePointsPerUsd;
        d.sellUsd += fee * share;
      }
      days.set(k, d);
    }
    for (const d of days.values()) {
      const pts = Math.min(B.scoutFeeCapPerDayApp, Math.min(R.scoutFeeCapPerDay, d.plain) + d.app + d.sell);
      if (pts <= 0) continue;
      const w = get(d.trader);
      w.scout += pts;
      w.scoutWhy.feesUsd += d.feesUsd;
      if (d.appUsd > 0) w.scoutWhy.appFeesUsd = (w.scoutWhy.appFeesUsd ?? 0) + d.appUsd;
      if (d.sellUsd > 0) w.scoutWhy.sellFeesUsd = (w.scoutWhy.sellFeesUsd ?? 0) + d.sellUsd;
    }
  }

  for (const w of [...wallets.keys()]) {
    const s = wallets.get(w)!;
    if (input.flagged.has(w)) {
      wallets.delete(w);
      continue;
    }
    s.creator = Math.round(s.creator);
    s.scout = Math.round(s.scout);
    s.total = s.creator + s.scout;
    const cents = (n: number) => Math.round(n * 100) / 100;
    s.creatorWhy.feesUsd = cents(s.creatorWhy.feesUsd);
    s.scoutWhy.feesUsd = cents(s.scoutWhy.feesUsd);
    if (s.creatorWhy.volumeUsd !== undefined) s.creatorWhy.volumeUsd = cents(s.creatorWhy.volumeUsd);
    if (s.scoutWhy.appFeesUsd !== undefined) s.scoutWhy.appFeesUsd = cents(s.scoutWhy.appFeesUsd);
    if (s.scoutWhy.sellFeesUsd !== undefined) s.scoutWhy.sellFeesUsd = cents(s.scoutWhy.sellFeesUsd);
    if (s.total <= 0) wallets.delete(w);
  }
  return { wallets, realHolders: new Map([...realHolders].map(([k, v]) => [k, v.length])) };
}

/** How many unverified holders count beside `eligible` eligible ones: max(10, 2 × eligible). */
export function unverifiedAllowance(eligible: number, rules: Rules = RULES_V1): number {
  return Math.max(rules.unverifiedFree, rules.unverifiedPerVerified * eligible);
}

/**
 * The fewest eligible holders a token needs to reach `counted` counted holders, however many unverified ones it has:
 * the real floor behind a "20+ counted holders" gate (7 there, so its "5+ eligible" never decides on its own).
 */
export function eligibleNeededFor(counted: number, rules: Rules = RULES_V1): number {
  let e = 0;
  while (e + unverifiedAllowance(e, rules) < counted) e++;
  return e;
}

/** Counted holders: every eligible one, and unverified ones up to the allowance (a crowd of fresh wallets reaches no threshold alone). */
export function countedHolders(eligible: number, unverified: number, rules: Rules = RULES_V1): number {
  return eligible + Math.min(unverified, unverifiedAllowance(eligible, rules));
}

/**
 * The token price a run holds balances to, from its last trade price at the cut-off and 12 h and 24 h before it
 * (newest first; null where it had not traded yet): the median of three, the older of two (a pump in the last hours
 * moves neither), the one there is, or null. A single block's pump or dump at the end of a season then moves nothing.
 */
export function steadyPrice(samples: readonly (number | null)[]): number | null {
  const known = samples.filter((p): p is number => p !== null && Number.isFinite(p) && p > 0);
  if (known.length === 0) return null;
  if (known.length >= 3) return [...known].sort((a, b) => a - b)[Math.floor(known.length / 2)];
  return known[known.length - 1]; // newest first: the last is the oldest
}

/** Points-eligible profile: X-verified, public, not kept off points, on an account old and followed enough. */
export function isEligible(p: { x_status: string; x_account_created: string | null; x_followers: number | null; points_flag: string | null; hidden: boolean; deleted_at?: string | null }, now: number): boolean {
  if (p.hidden || p.points_flag || p.deleted_at || p.x_status !== "verified") return false;
  if (!p.x_account_created || p.x_followers === null) return false;
  return now - new Date(p.x_account_created).getTime() >= RULES.eligibleMinAgeDays * DAY && p.x_followers >= RULES.eligibleMinFollowers;
}

/** Why a wallet is not on the board yet (for /me): the one step that would change it. */
export type NotEligibleReason = "no_profile" | "not_verified" | "account_too_new" | "few_followers" | "hidden" | "kept_off";
/** The reasons anyone may be told (being kept off points is a moderator's call that never is). */
export type PublicReason = Exclude<NotEligibleReason, "kept_off">;
export const PUBLIC_REASONS: readonly PublicReason[] = ["no_profile", "not_verified", "account_too_new", "few_followers", "hidden"];
/** Why a wallet is not on the board yet, as the one step that would change it (null when it is eligible). */
export function notEligibleReason(p: { x_status: string; x_account_created: string | null; x_followers: number | null; points_flag: string | null; hidden: boolean; deleted_at?: string | null } | null, now: number): NotEligibleReason | null {
  if (!p || p.deleted_at) return "no_profile";
  if (p.points_flag) return "kept_off";
  if (p.hidden) return "hidden";
  if (p.x_status !== "verified") return "not_verified";
  if (!p.x_account_created || now - new Date(p.x_account_created).getTime() < RULES.eligibleMinAgeDays * DAY) return "account_too_new";
  if (p.x_followers === null || p.x_followers < RULES.eligibleMinFollowers) return "few_followers";
  return null;
}

/** Ranks among eligible wallets (1 = best); ties share a rank. */
export function rankBy(scores: readonly WalletScore[], field: "creator" | "scout", eligible: ReadonlySet<string>): Map<string, number> {
  const list = scores.filter((s) => eligible.has(s.wallet) && s[field] > 0).sort((a, b) => b[field] - a[field] || a.wallet.localeCompare(b.wallet));
  const out = new Map<string, number>();
  let rank = 0;
  let prev = Number.NaN;
  list.forEach((s, i) => {
    if (s[field] !== prev) {
      rank = i + 1;
      prev = s[field];
    }
    out.set(s.wallet, rank);
  });
  return out;
}

/** One line of "why" for a leaderboard row, from the breakdown. */
export function whyLine(board: "creator" | "scout", s: Pick<WalletScore, "creatorWhy" | "scoutWhy">): string {
  const parts: string[] = [];
  const usd = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;
  if (board === "creator") {
    const c = s.creatorWhy;
    if (c.verifiedHolders) parts.push(`${c.verifiedHolders} verified holder${c.verifiedHolders === 1 ? "" : "s"}`);
    if (c.holders) parts.push(`${c.holders} holder${c.holders === 1 ? "" : "s"}`);
    if (c.feesUsd >= 0.01) parts.push(`${usd(c.feesUsd)} fees from verified traders`);
    if (c.volumePts) parts.push(`${usd(c.volumeUsd ?? 0)} qualified volume`);
  } else {
    const c = s.scoutWhy;
    if (c.early) parts.push(`early on ${c.early} token${c.early === 1 ? "" : "s"}`);
    if (c.holds) parts.push(`${c.holds} held a day+`);
    if (c.feesUsd >= 0.01) parts.push(`${usd(c.feesUsd)} fees paid${(c.appFeesUsd ?? 0) >= 0.01 ? ` (${usd(c.appFeesUsd ?? 0)} in the app)` : ""}`);
    if ((c.sellFeesUsd ?? 0) >= 0.01) parts.push(`${usd(c.sellFeesUsd ?? 0)} fees on sells after a week`);
  }
  return parts.join(" · ");
}
