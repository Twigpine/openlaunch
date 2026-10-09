/**
 * Season points, the pure half (node --test loads this directly; relative imports only).
 *
 * Points are reputation for launching and trading, recomputed from scratch from the chain index. Every rule is
 * built on two definitions that cost real money to fake:
 *
 *   real buyer  = a wallet whose FIRST buy of a token was ≥ $5, outside the sniper window (the launch block + 3, and
 *                 the first 12 seconds), that received the tokens of that buy itself (a relayer or bundler a swap was
 *                 credited to, or a router forwarding to someone else, is not a buyer), and that is not the launcher,
 *                 a fee recipient, a protocol address, a wallet that got the token by transfer from the launcher or a
 *                 recipient, or a wallet kept off points
 *   real holder = a real buyer with ≥ $5 (≥ $1 if their profile is points-eligible) of that first buy's lot still left
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
 *       else 5; a week or more ago: half again. A holder counts once per creator (their best token).
 *     - 10 per $1 of fees on buys ≥ $5 by points-eligible outside traders, for each buy half of which has been held ever
 *       since (a round trip earns nothing); at most 50 per trader per creator per day
 *     - a token scores 0 if its creator moved tokens out during the season (a sell, or a transfer to any wallet, a
 *       side wallet that then sells included; burning is not moving out) and less than half of their own buys is
 *       left
 *     - of the tokens a wallet launched on one UTC day, only the best 3 count (ranked with the fee cap applied)
 *   Scout (traders)
 *     - one of the first 25 real buyers of a token that now has 50+ real holders, buying in the season: 100, and 50
 *       more while still holding half of that first buy
 *     - 5 per token the wallet first bought in the season (a real buy) and still half-held a day later; at most 20
 *       tokens per UTC day
 *     - 10 per $1 of fees paid on buys ≥ $5 of other people's tokens with 20+ real holders (5+ of them eligible), for
 *       each buy half of which has been held ever since; at most 200 a day
 *
 * Only points-eligible wallets rank; everyone else sees what is waiting for them.
 */

export const RULES = {
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
  // points-eligible profile: X-verified on an account this old with this many followers
  eligibleMinAgeDays: 30,
  eligibleMinFollowers: 20,
} as const;

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
export type ScoreSwap = { key: string; trader: string; isBuy: boolean; quoteRaw: bigint; tokenRaw: bigint; block: number; logIndex: number; time: number; tx: string };
/** A wallet's first buy of a token, all-time (its rank among real buyers decides "early"). */
export type FirstBuy = { key: string; wallet: string; block: number; logIndex: number; time: number; quoteRaw: bigint; tokenRaw: bigint; tx: string };

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
  /** per token: wallets that received it by transfer from the launcher or a fee recipient */
  linked: ReadonlyMap<string, ReadonlySet<string>>;
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
};

export type CreatorBreakdown = { tokens: number; verifiedHolders: number; holders: number; feesUsd: number; dumped: number };
export type ScoutBreakdown = { early: number; holds: number; feesUsd: number };
export type WalletScore = { wallet: string; creator: number; scout: number; total: number; creatorWhy: CreatorBreakdown; scoutWhy: ScoutBreakdown };
export type ScoreResult = { wallets: Map<string, WalletScore>; realHolders: Map<string, number> };

/** A raw token amount in whole units. */
const units = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;
/** The UTC day number of a moment (for per-day caps and the best-3-per-launch-day rule). */
const utcDay = (ms: number) => Math.floor(ms / DAY);

/** Score one season from the chain index (pure): real buyers and holders, creator and scout points, caps, and the why behind each. */
export function scoreSeason(input: ScoreInput): ScoreResult {
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
  const insider = (l: ScoreLaunch, w: string) => w === l.launcher || l.recipients.includes(w) || input.system.has(w) || input.flagged.has(w) || (input.linked.get(l.key)?.has(w) ?? false);
  const sniper = (l: ScoreLaunch, block: number, time: number) => block <= l.launchBlock + RULES.sniperBlocks || time - l.launchTime < RULES.sniperMs;
  const quoteUsd = (l: ScoreLaunch, raw: bigint) => units(raw, l.quoteDecimals) * (l.quoteUsd as number);
  const tokenUsd = (l: ScoreLaunch, raw: bigint) => units(raw, 18) * (l.tokenUsd as number);
  const inSeason = (t: number) => t >= input.seasonStart && t < end;
  // lots per (token, wallet): each incoming transfer is a lot; each outgoing one uses up the newest lots first (LIFO).
  // A lot only ever shrinks, so what is left of it at the end is the least it ever held. Linear in the moves.
  const lotsByTx = new Map<string, bigint>(); // `${key}|${wallet}|${tx}` → what is left of the lots that tx brought in
  const receivedByTx = new Map<string, bigint>(); // `${key}|${wallet}|${tx}` → what that tx brought in at all
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
      const stack: { tx: string; left: bigint }[] = [];
      const all: { tx: string; left: bigint }[] = [];
      for (const m of [...byAt.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
        if (m.delta > 0n) {
          const lot = { tx: m.tx, left: m.delta };
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
            if (top.left === 0n) stack.pop();
          }
        }
      }
      for (const lot of all) lotsByTx.set(`${k}|${lot.tx}`, (lotsByTx.get(`${k}|${lot.tx}`) ?? 0n) + lot.left);
    }
  }
  /** What is left of the tokens a transaction brought into a wallet (matched by transaction, not log order). */
  const leftOf = (key: string, w: string, tx: string) => lotsByTx.get(`${key}|${w}|${tx}`) ?? 0n;
  /** At least half of a buy's own lot left. */
  const halfLeft = (key: string, w: string, tx: string, boughtRaw: bigint) => {
    const left = leftOf(key, w, tx);
    return left > 0n && left * 2n >= boughtRaw;
  };

  /** The wallet received at least half of what a buy bought, in that buy's own transaction. */
  const received = (key: string, w: string, tx: string, boughtRaw: bigint) => (receivedByTx.get(`${key}|${w}|${tx}`) ?? 0n) * 2n >= boughtRaw;

  // real buyers per token, in buy order
  const realBuyers = new Map<string, FirstBuy[]>();
  for (const f of input.firstBuys) {
    const l = launches.get(f.key);
    if (!l || insider(l, f.wallet) || sniper(l, f.block, f.time) || quoteUsd(l, f.quoteRaw) < RULES.minTradeUsd) continue;
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
    const held = list.filter((f) => tokenUsd(l, leftOf(key, f.wallet, f.tx)) >= (input.eligible.has(f.wallet) ? RULES.verifiedHolderMinUsd : RULES.holderMinUsd));
    realHolders.set(key, held);
  }
  const holderCount = (key: string) => realHolders.get(key)?.length ?? 0;

  // the season's outside trades (≥ $5, outside the sniper window), and what each creator sold
  const outside: ScoreSwap[] = [];
  const creatorSold = new Set<string>();
  for (const s of input.swaps) {
    const l = launches.get(s.key);
    if (!l || !inSeason(s.time)) continue;
    if (s.trader === l.launcher && !s.isBuy) creatorSold.add(s.key);
    if (insider(l, s.trader) || sniper(l, s.block, s.time) || quoteUsd(l, s.quoteRaw) < RULES.minTradeUsd) continue;
    outside.push(s);
  }

  // net buying: a buy earns fee points only if at least half of it has been held every moment since, so a round trip
  // (the fees coming back to a farmer's own token) earns nothing and washing ties up real capital for the season
  const heldBuy = (s: ScoreSwap) => halfLeft(s.key, s.trader, s.tx, s.tokenRaw);
  const eligibleHolders = new Map<string, number>();
  for (const [key, list] of realHolders) eligibleHolders.set(key, list.filter((f) => input.eligible.has(f.wallet)).length);

  // ── creator points ──
  type TokenCreator = { l: ScoreLaunch; holders: { wallet: string; pts: number; eligible: boolean }[]; fees: { trader: string; day: number; usd: number }[]; dumped: boolean };
  const perToken = new Map<string, TokenCreator>();
  const ensure = (l: ScoreLaunch) => {
    let t = perToken.get(l.key);
    if (!t) {
      t = { l, holders: [], fees: [], dumped: false };
      perToken.set(l.key, t);
    }
    return t;
  };
  for (const [key, list] of realHolders) {
    const l = launches.get(key)!;
    for (const f of list) {
      if (!inSeason(f.time) || end - f.time < DAY) continue; // gained this season, held a day
      const eligible = input.eligible.has(f.wallet);
      const pts = (eligible ? RULES.verifiedHolder : RULES.holder) * (end - f.time >= 7 * DAY ? 1 + RULES.weekBonus : 1);
      ensure(l).holders.push({ wallet: f.wallet, pts, eligible });
    }
  }
  for (const s of outside) {
    // fees count only on buys by points-eligible traders who are net buyers: wash trades need real accounts and capital
    if (!s.isBuy || !input.eligible.has(s.trader) || !heldBuy(s)) continue;
    const l = launches.get(s.key)!;
    const fee = (quoteUsd(l, s.quoteRaw) * l.lpFee) / 1_000_000;
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
  for (const t of perToken.values()) {
    const buys = input.launcherBuys.get(t.l.key) ?? [];
    const bought = buys.reduce((a, b) => a + b.tokenRaw, 0n);
    const left = buys.reduce((a, b) => a + leftOf(t.l.key, t.l.launcher, b.tx), 0n);
    // a dump = tokens moved out during the season and less than half of the creator's own buys is left (fee tokens
    // that came in after the buys are used up first, so selling those is not one)
    if (bought > 0n && creatorOut.has(t.l.key) && left * 2n < bought) t.dumped = true;
  }
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
    const assign = (pool: readonly TokenCreator[]) => {
      const best = new Map<string, { t: TokenCreator; pts: number; eligible: boolean }>();
      for (const t of pool) {
        for (const h of t.holders) {
          const cur = best.get(h.wallet);
          if (!cur || h.pts > cur.pts) best.set(h.wallet, { t, pts: h.pts, eligible: h.eligible });
        }
      }
      return best;
    };
    /** Fee points of one token, at most 50 per trader per day, counting what `used` already holds for this creator. */
    const feePoints = (t: TokenCreator, used: Map<string, number>) => {
      let pts = 0;
      let usd = 0;
      for (const f of t.fees) {
        const k = `${f.trader}|${f.day}`;
        const already = used.get(k) ?? 0;
        const p = Math.min(f.usd * RULES.creatorFeePointsPerUsd, RULES.creatorFeeCapPerTraderDay - already);
        if (p <= 0) continue;
        used.set(k, already + p);
        pts += p;
        usd += f.usd;
      }
      return { pts, usd };
    };
    // the best 3 tokens of each launch day, ranked by what each would actually be worth: its holders (each on their
    // best token) and its fees with the per-trader-per-day cap applied (an uncapped estimate let one big fee payer
    // push a token with real holders out of the 3)
    const firstPass = new Map<TokenCreator, number>();
    for (const [, h] of assign(live)) firstPass.set(h.t, (firstPass.get(h.t) ?? 0) + h.pts);
    const estimate = new Map(live.map((t) => [t, (firstPass.get(t) ?? 0) + feePoints(t, new Map()).pts]));
    const byDay = new Map<number, TokenCreator[]>();
    for (const t of live) {
      const d = utcDay(t.l.launchTime);
      byDay.set(d, [...(byDay.get(d) ?? []), t]);
    }
    const kept: TokenCreator[] = [];
    for (const list of byDay.values()) kept.push(...[...list].sort((a, b) => (estimate.get(b) ?? 0) - (estimate.get(a) ?? 0)).slice(0, RULES.bestTokensPerDay));
    kept.sort((a, b) => (estimate.get(b) ?? 0) - (estimate.get(a) ?? 0) || a.l.key.localeCompare(b.l.key));
    // the count: each holder on their best kept token (a holder whose favourite was cut still counts on another), and
    // fees with the cap shared across all of this creator's kept tokens
    const holderBest = assign(kept);
    const value = new Map<TokenCreator, number>();
    for (const [, h] of holderBest) value.set(h.t, (value.get(h.t) ?? 0) + h.pts);
    const feeUsed = new Map<string, number>();
    const counted = new Set<string>();
    for (const t of kept) {
      const fees = feePoints(t, feeUsed);
      const v = (value.get(t) ?? 0) + fees.pts;
      if (v <= 0) continue;
      s.creator += v;
      s.creatorWhy.tokens++;
      s.creatorWhy.feesUsd += fees.usd;
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
    if (holderCount(key) < RULES.earlyHoldersTarget) continue;
    for (const f of list.slice(0, RULES.earlyFirstBuyers)) {
      if (!inSeason(f.time)) continue;
      const s = get(f.wallet);
      s.scout += RULES.early + (halfLeft(key, f.wallet, f.tx, f.tokenRaw) ? RULES.earlyStillHolding : 0);
      s.scoutWhy.early++;
    }
  }
  // holds: a token the wallet FIRST bought in the season (its first buy ever was a real buy, in the season), half of
  // that buy held a day later; a later buy of a token held from before the season, or after a first buy that was not
  // a real one (a sniper, under $5), earns nothing
  const firstInSeason: FirstBuy[] = [];
  for (const list of realBuyers.values()) for (const f of list) if (inSeason(f.time)) firstInSeason.push(f);
  const holdsPerDay = new Map<string, number>();
  for (const f of firstInSeason.sort((a, b) => a.time - b.time || a.block - b.block || a.logIndex - b.logIndex)) {
    if (end - f.time < DAY || !halfLeft(f.key, f.wallet, f.tx, f.tokenRaw)) continue;
    const dayKey = `${f.wallet}|${utcDay(f.time)}`;
    const n = holdsPerDay.get(dayKey) ?? 0;
    if (n >= RULES.holdTokensPerDay) continue;
    holdsPerDay.set(dayKey, n + 1);
    const w = get(f.wallet);
    w.scout += RULES.hold;
    w.scoutWhy.holds++;
  }
  const scoutFeeUsed = new Map<string, number>();
  for (const s of outside) {
    if (!s.isBuy || !heldBuy(s)) continue;
    if (holderCount(s.key) < RULES.scoutFeeMinHolders || (eligibleHolders.get(s.key) ?? 0) < RULES.scoutFeeMinEligibleHolders) continue;
    const l = launches.get(s.key)!;
    const fee = (quoteUsd(l, s.quoteRaw) * l.lpFee) / 1_000_000;
    if (fee <= 0) continue;
    const k = `${s.trader}|${utcDay(s.time)}`;
    const used = scoutFeeUsed.get(k) ?? 0;
    const pts = Math.min(fee * RULES.scoutFeePointsPerUsd, RULES.scoutFeeCapPerDay - used);
    if (pts <= 0) continue;
    scoutFeeUsed.set(k, used + pts);
    const w = get(s.trader);
    w.scout += pts;
    w.scoutWhy.feesUsd += fee;
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
    s.creatorWhy.feesUsd = Math.round(s.creatorWhy.feesUsd * 100) / 100;
    s.scoutWhy.feesUsd = Math.round(s.scoutWhy.feesUsd * 100) / 100;
    if (s.total <= 0) wallets.delete(w);
  }
  return { wallets, realHolders: new Map([...realHolders].map(([k, v]) => [k, v.length])) };
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
  } else {
    const c = s.scoutWhy;
    if (c.early) parts.push(`early on ${c.early} token${c.early === 1 ? "" : "s"}`);
    if (c.holds) parts.push(`${c.holds} held a day+`);
    if (c.feesUsd >= 0.01) parts.push(`${usd(c.feesUsd)} fees paid`);
  }
  return parts.join(" · ");
}
