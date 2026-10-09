import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES, isEligible, notEligibleReason, rankBy, scoreSeason, whyLine, type FirstBuy, type ScoreInput, type ScoreLaunch, type ScoreSwap } from "./score.ts";

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1);
const NOW = START + 10 * DAY;
const CREATOR = "0xc0";
const RECIP = "0xfe";
const E18 = 10n ** 18n;
const eth = (n: number) => BigInt(Math.round(n * 1e9)) * 10n ** 9n; // n ETH in wei
const w = (i: number) => `0x${i.toString(16).padStart(4, "0")}`;

// launched before the season: ETH at $2,000, 1% fee, token at $0.001 (so 0.0025 ETH = $5 buys 5,000 tokens)
const L: ScoreLaunch = { key: "base:0xt1", launcher: CREATOR, recipients: [RECIP], launchBlock: 100, launchTime: START - 30 * DAY, lpFee: 10_000, quoteDecimals: 18, quoteUsd: 2000, tokenUsd: 0.001 };
const tokensFor = (ethIn: number) => BigInt(Math.round((ethIn * 2000) / 0.001)) * E18;
type Move = ScoreInput["moves"][number];

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return { seasonStart: START, seasonEnd: START + 28 * DAY, now: NOW, launches: [L], swaps: [], firstBuys: [], moves: [], launcherBuys: new Map(), linked: new Map(), system: new Set(["0xpool"]), eligible: new Set(), flagged: new Set(), seasonStartBlocks: new Map([["base", 1_000]]), ...over };
}
let n = 0;
/** a wallet that bought `ethIn` at `t` (the swap, then its token transfer in) and later sold all but `keep` of it */
function buyer(wallet: string, t: number, ethIn: number, keep = 1, launch: ScoreLaunch = L, block = 1000 + n) {
  n++;
  const tokenRaw = tokensFor(ethIn);
  const li = n * 10;
  const tx = `0xbuy${n}`;
  const swap: ScoreSwap = { key: launch.key, trader: wallet, isBuy: true, quoteRaw: eth(ethIn), tokenRaw, block, logIndex: li, time: t, tx };
  const first: FirstBuy = { key: launch.key, wallet, block, logIndex: li, time: t, quoteRaw: eth(ethIn), tokenRaw, tx };
  const moves: Move[] = [{ key: launch.key, wallet, block, logIndex: li + 1, tx, delta: tokenRaw }];
  if (keep < 1) moves.push({ key: launch.key, wallet, block: block + 50_000, logIndex: n, tx: `0xsell${n}`, delta: -((tokenRaw * BigInt(Math.round((1 - keep) * 1000))) / 1000n) });
  return { swap, first, moves };
}
function build(buyers: ReturnType<typeof buyer>[], over: Partial<ScoreInput> = {}) {
  return input({ swaps: buyers.map((b) => b.swap), firstBuys: buyers.map((b) => b.first), moves: buyers.flatMap((b) => b.moves), ...over });
}

// ── the rules ────────────────────────────────────────────────────────────────
test("a real holder who bought this season and held a day earns the creator 30 if eligible, 5 if not; half again after a week", () => {
  const b1 = buyer(w(1), START + DAY, 0.0025); // $5
  const b2 = buyer(w(2), NOW - 2 * DAY, 0.0025);
  const r = scoreSeason(build([b1, b2], { eligible: new Set([w(1)]) }));
  const c = r.wallets.get(CREATOR)!;
  assert.equal(c.creatorWhy.verifiedHolders, 1);
  assert.equal(c.creatorWhy.holders, 1);
  // fees come only from eligible traders' held buys: w(1)'s $5 at 1% = $0.05 → 0.5 points
  assert.equal(c.creator, Math.round(30 * 1.5 + 5 + 0.5));
});

test("holders gained before the season, held under a day, or below their floor earn nothing", () => {
  const before = buyer(w(1), START - DAY, 0.01);
  const fresh = buyer(w(2), NOW - 3_600_000, 0.01);
  const sold = buyer(w(3), START + DAY, 0.01, 0.1); // keeps $2: under the $5 floor
  const r = scoreSeason(build([before, fresh, sold]));
  assert.equal(r.wallets.get(CREATOR)?.creatorWhy.holders ?? 0, 0);
});

test("eligible holders need only $1 held; a first buy under $5 is never a real buyer", () => {
  const verified = buyer(w(1), START + DAY, 0.0025, 0.3); // $1.50 held
  const small = buyer(w(2), START + DAY, 0.002); // $4 buy
  const r = scoreSeason(build([verified, small], { eligible: new Set([w(1), w(2)]) }));
  assert.equal(r.wallets.get(CREATOR)!.creatorWhy.verifiedHolders, 1);
});

test("the creator, fee recipients, transfer-fed wallets and snipers (by block or by the first 12 s) are never real buyers", () => {
  const self = buyer(CREATOR, START + DAY, 1);
  const recip = buyer(RECIP, START + DAY, 1);
  const sock = buyer(w(9), START + DAY, 1);
  const blockSniper = buyer(w(8), START + DAY, 1, 1, L, L.launchBlock + 2);
  const fresh: ScoreLaunch = { ...L, key: "base:0xfresh", launchTime: START + DAY };
  const timeSniper = buyer(w(7), START + DAY + 5_000, 1, 1, fresh, 99_999);
  const r = scoreSeason(build([self, recip, sock, blockSniper, timeSniper], { launches: [L, fresh], linked: new Map([[L.key, new Set([w(9)])]]), eligible: new Set([w(7), w(8), w(9)]) }));
  assert.equal(r.wallets.get(CREATOR)?.creator ?? 0, 0);
  assert.equal(r.realHolders.get(L.key) ?? 0, 0);
});

test("only the best 3 tokens a wallet launched on one day count, and each holder counts once per creator", () => {
  const launches = Array.from({ length: 5 }, (_, i) => ({ ...L, key: `base:0xd${i}`, launchTime: START - DAY + i }));
  const buyers = launches.flatMap((l, i) => Array.from({ length: i + 1 }, (_, j) => buyer(w(100 * (i + 1) + j), START + DAY, 0.003, 1, l)));
  const r = scoreSeason(build(buyers, { launches }));
  assert.equal(r.wallets.get(CREATOR)!.creatorWhy.tokens, 3);
  assert.equal(r.wallets.get(CREATOR)!.creatorWhy.holders, 5 + 4 + 3);
  // one eligible fan holding all five tokens counts once
  const fan = launches.map((l) => buyer(w(1), START + DAY, 0.003, 1, l));
  const r2 = scoreSeason(build(fan, { launches, eligible: new Set([w(1)]) }));
  assert.equal(r2.wallets.get(CREATOR)!.creatorWhy.verifiedHolders, 1);
});

test("dump: sold this season and dropped below half of what was bought → 0; selling only the fee tokens is fine", () => {
  const b = buyer(w(1), START + DAY, 0.01);
  const sell: ScoreSwap = { key: L.key, trader: CREATOR, isBuy: false, quoteRaw: eth(0.1), tokenRaw: 600_000n * E18, block: 3000, logIndex: 10, time: START + 2 * DAY, tx: "0xcs" };
  const bought = new Map([[L.key, [{ tx: "0xcb", tokenRaw: 1_000_000n * E18 }]]]);
  const boughtIn: Move = { key: L.key, wallet: CREATOR, block: 50, logIndex: 1, tx: "0xcb", delta: 1_000_000n * E18 };
  const sold: Move = { key: L.key, wallet: CREATOR, block: 3000, logIndex: 11, tx: "0xcs", delta: -600_000n * E18 };
  const dumped = scoreSeason(build([b], { swaps: [b.swap, sell], launcherBuys: bought, moves: [...b.moves, boughtIn, sold] }));
  assert.equal(dumped.wallets.get(CREATOR)?.creator ?? 0, 0);
  const feeIn: Move = { key: L.key, wallet: CREATOR, block: 2000, logIndex: 1, tx: "0xfee", delta: 600_000n * E18 }; // fee tokens paid by the locker
  const feeSale = scoreSeason(build([b], { swaps: [b.swap, sell], launcherBuys: bought, moves: [...b.moves, boughtIn, feeIn, sold] }));
  assert.ok((feeSale.wallets.get(CREATOR)?.creator ?? 0) > 0, "sold the fee tokens, kept everything bought");
});

test("early: first 25 real buyers of a token with 50+ real holders; +50 only if half of that buy was held throughout", () => {
  const buyers = Array.from({ length: 52 }, (_, i) => buyer(w(i + 1), START + DAY + i * 1000, 0.003, i === 0 ? 0.3 : 1, L, 1000 + i));
  const r = scoreSeason(build(buyers));
  assert.equal(r.realHolders.get(L.key), 52 - 1, "w(1) dropped to $1.80: not a real holder (unverified needs $5)");
  assert.equal(r.wallets.get(w(1))!.scoutWhy.early, 1);
  assert.equal(r.wallets.get(w(2))!.scout - r.wallets.get(w(1))!.scout, RULES.earlyStillHolding + RULES.hold);
  assert.equal(r.wallets.get(w(26))?.scoutWhy.early ?? 0, 0);
});

test("early slots go to real buyers only: sub-$5 first buys cannot crowd them out", () => {
  const crowd = Array.from({ length: 25 }, (_, i) => buyer(w(500 + i), START + DAY + i, 0.001, 1, L, 900 + i)); // $2 each
  const real = Array.from({ length: 52 }, (_, i) => buyer(w(i + 1), START + DAY + 100 + i, 0.003, 1, L, 1000 + i));
  const r = scoreSeason(build([...crowd, ...real]));
  assert.equal(r.wallets.get(w(1))!.scoutWhy.early, 1);
});

test("holds: first buy ≥ $5 this season, half held throughout for a day; 20 tokens a day", () => {
  const launches = Array.from({ length: 25 }, (_, i) => ({ ...L, key: `base:0xh${i}` }));
  const r = scoreSeason(build(launches.map((l) => buyer(w(1), START + DAY, 0.003, 1, l)), { launches }));
  assert.equal(r.wallets.get(w(1))!.scoutWhy.holds, RULES.holdTokensPerDay);
  const soldDown = scoreSeason(build([buyer(w(2), START + DAY, 0.003, 0.4)]));
  assert.equal(soldDown.wallets.get(w(2))?.scoutWhy.holds ?? 0, 0, "sold down to 40%: no hold");
});

test("scout fees: held buys on tokens with 20+ real holders (5+ eligible), at most 200 a day; round trips earn nothing", () => {
  const holders = Array.from({ length: 20 }, (_, i) => buyer(w(100 + i), START + DAY, 0.003));
  const eligible = new Set(holders.slice(0, 5).map((h) => h.first.wallet));
  const buys: ScoreSwap[] = Array.from({ length: 30 }, (_, i) => ({ key: L.key, trader: w(1), isBuy: true, quoteRaw: eth(1), tokenRaw: tokensFor(1), block: 6000 + i, logIndex: 10, time: START + 2 * DAY + i, tx: `0xsb${i}` }));
  const ins: Move[] = buys.map((b) => ({ key: L.key, wallet: w(1), block: b.block, logIndex: 11, tx: b.tx, delta: b.tokenRaw }));
  const base = { swaps: [...holders.map((h) => h.swap), ...buys], firstBuys: holders.map((h) => h.first), moves: [...holders.flatMap((h) => h.moves), ...ins], eligible };
  const kept = scoreSeason(input(base)).wallets.get(w(1))!;
  assert.ok(kept.scoutWhy.feesUsd > 0);
  assert.ok(kept.scout <= RULES.scoutFeeCapPerDay + RULES.hold);
  const roundTrip = scoreSeason(input({ ...base, moves: [...base.moves, { key: L.key, wallet: w(1), block: 9000, logIndex: 0, tx: "0xsellall", delta: -tokensFor(1) * 30n }] }));
  assert.equal(roundTrip.wallets.get(w(1))?.scoutWhy.feesUsd ?? 0, 0, "sold it all again: no fee points for any of those buys");
  assert.equal(scoreSeason(input({ ...base, eligible: new Set() })).wallets.get(w(1))?.scoutWhy.feesUsd ?? 0, 0, "fewer than 5 eligible holders");
  assert.equal(scoreSeason(input({ swaps: buys, moves: ins })).wallets.get(w(1))?.scoutWhy.feesUsd ?? 0, 0, "no real holders");
});

// ── the farms the reviews found, as regressions ──────────────────────────────
test("farm: an unpriced quote (a farmer's own ERC-20) earns nothing at all", () => {
  const fake: ScoreLaunch = { ...L, key: "base:0xfake", quoteUsd: null, tokenUsd: null, launchTime: START + DAY };
  const socks = Array.from({ length: 50 }, (_, i) => buyer(w(i + 1), START + DAY + 60_000 + i, 1, 1, fake, 500 + i));
  assert.equal(scoreSeason(build(socks, { launches: [fake], eligible: new Set([w(1)]) })).wallets.size, 0);
});

test("farm: dust sent to 50 wallets makes none of them holders and unlocks nothing", () => {
  const scout = buyer(w(1), START + DAY, 0.0025, 0.0001);
  const dust: Move[] = Array.from({ length: 50 }, (_, i) => ({ key: L.key, wallet: w(1000 + i), block: 70_000, logIndex: i, tx: `0xdust${i}`, delta: 1n }));
  const r = scoreSeason(build([scout], { moves: [...scout.moves, ...dust], eligible: new Set([w(1)]) }));
  assert.equal(r.realHolders.get(L.key) ?? 0, 0);
  assert.equal(r.wallets.get(w(1))?.scout ?? 0, 0);
});

test("farm: wash trading earns nothing, verified or not; a verified buyer holding throughout gives the creator at most 50 a day", () => {
  const swaps: ScoreSwap[] = [];
  const moves: Move[] = [];
  for (let i = 0; i < 100; i++) {
    const buy = i % 2 === 0;
    swaps.push({ key: L.key, trader: "0xpuppet", isBuy: buy, quoteRaw: eth(10), tokenRaw: tokensFor(10), block: 1000 + i, logIndex: 10, time: START + 2 * DAY + i * 1000, tx: `0xw${i}` });
    moves.push({ key: L.key, wallet: "0xpuppet", block: 1000 + i, logIndex: 11, tx: `0xw${i}`, delta: buy ? tokensFor(10) : -tokensFor(10) });
  }
  assert.equal(scoreSeason(input({ swaps, moves })).wallets.get(CREATOR)?.creator ?? 0, 0);
  assert.equal(scoreSeason(input({ swaps, moves, eligible: new Set(["0xpuppet"]) })).wallets.get(CREATOR)?.creator ?? 0, 0, "round trips by a verified wallet");
  const net = scoreSeason(input({ swaps: swaps.filter((x) => x.isBuy), moves: moves.filter((m) => m.delta > 0n), eligible: new Set(["0xpuppet"]) }));
  assert.equal(net.wallets.get(CREATOR)!.creator, RULES.creatorFeeCapPerTraderDay, "$500 of buys held: capital at stake, capped");
});

test("farm: topping a wallet back up by transfer before the final count restores nothing", () => {
  // bought $5, sold out, then another wallet sends tokens back just before the count
  const b = buyer(w(1), START + DAY, 0.0025, 0);
  const topUp: Move = { key: L.key, wallet: w(1), block: 900_000, logIndex: 0, tx: "0xtopup", delta: tokensFor(0.0025) * 10n };
  const r = scoreSeason(build([b], { moves: [...b.moves, topUp], eligible: new Set([w(1)]) }));
  assert.equal(r.realHolders.get(L.key) ?? 0, 0);
  assert.equal(r.wallets.get(CREATOR)?.creator ?? 0, 0);
  assert.equal(r.wallets.get(w(1))?.scout ?? 0, 0);
});

test("farm: $5 passed from puppet to puppet counts for none of them", () => {
  const puppets = Array.from({ length: 30 }, (_, i) => {
    const b = buyer(w(200 + i), START + DAY + i * 1000, 0.0025);
    // each puppet hands its tokens on to a collector right after buying
    b.moves.push({ key: L.key, wallet: w(200 + i), block: b.swap.block + 1, logIndex: 0, tx: `0xrelay${i}`, delta: -b.swap.tokenRaw });
    return b;
  });
  const r = scoreSeason(build(puppets));
  assert.equal(r.realHolders.get(L.key) ?? 0, 0);
  assert.equal(r.wallets.get(CREATOR)?.creator ?? 0, 0);
});

test("farm: a small base position held all season does not cover later round trips", () => {
  // $5 bought and held, then 50 same-day round trips of $5 each: each sell uses up the lot it just bought
  const holders = Array.from({ length: 20 }, (_, i) => buyer(w(100 + i), START + DAY, 0.003));
  const eligible = new Set([w(1), ...holders.slice(0, 5).map((h) => h.first.wallet)]);
  const base = buyer(w(1), START + DAY, 0.0025);
  const swaps: ScoreSwap[] = [];
  const moves: Move[] = [];
  for (let i = 0; i < 100; i++) {
    const buy = i % 2 === 0;
    swaps.push({ key: L.key, trader: w(1), isBuy: buy, quoteRaw: eth(0.0025), tokenRaw: tokensFor(0.0025), block: 20_000 + i, logIndex: 10, time: START + 2 * DAY + i * 1000, tx: `0xrt${i}` });
    moves.push({ key: L.key, wallet: w(1), block: 20_000 + i, logIndex: 11, tx: `0xrt${i}`, delta: buy ? tokensFor(0.0025) : -tokensFor(0.0025) });
  }
  const r = scoreSeason(build([...holders, base], { swaps: [...holders.map((h) => h.swap), base.swap, ...swaps], moves: [...holders.flatMap((h) => h.moves), ...base.moves, ...moves], eligible }));
  assert.ok((r.wallets.get(w(1))?.scoutWhy.feesUsd ?? 0) <= 0.06, `only the base buy's fee may count, got ${r.wallets.get(w(1))?.scoutWhy.feesUsd}`);
});

test("a buy whose token transfer is logged before its swap (router takes first) still counts", () => {
  const b = buyer(w(1), START + DAY, 0.01);
  b.moves[0] = { ...b.moves[0], logIndex: b.swap.logIndex - 1 };
  const r = scoreSeason(build([b]));
  assert.equal(r.realHolders.get(L.key), 1);
  assert.equal(r.wallets.get(w(1))!.scoutWhy.holds, 1);
});

test("farm: a wallet kept off points (deleted profile or not) scores nothing and counts for no one", () => {
  const b = buyer(w(1), START + DAY, 0.01);
  const r = scoreSeason(build([b], { flagged: new Set([w(1)]), eligible: new Set([w(1)]) }));
  assert.equal(r.wallets.has(w(1)), false);
  assert.equal(r.wallets.get(CREATOR)?.creatorWhy.verifiedHolders ?? 0, 0);
});

// ── eligibility, ranks, why ──────────────────────────────────────────────────
test("eligibility and the reason shown when a wallet is not on the board", () => {
  const ok = { x_status: "verified", x_account_created: "2025-01-01T00:00:00Z", x_followers: 50, points_flag: null, hidden: false, deleted_at: null };
  assert.ok(isEligible(ok, NOW));
  assert.equal(notEligibleReason(ok, NOW), null);
  assert.equal(notEligibleReason(null, NOW), "no_profile");
  assert.equal(notEligibleReason({ ...ok, deleted_at: "2026-10-01T00:00:00Z" }, NOW), "no_profile");
  assert.equal(notEligibleReason({ ...ok, x_status: "none" }, NOW), "not_verified");
  assert.equal(notEligibleReason({ ...ok, x_account_created: new Date(NOW - 5 * DAY).toISOString() }, NOW), "account_too_new");
  assert.equal(notEligibleReason({ ...ok, x_followers: 3 }, NOW), "few_followers");
  assert.equal(notEligibleReason({ ...ok, points_flag: "excluded" }, NOW), "kept_off");
  assert.ok(!isEligible({ ...ok, deleted_at: "2026-10-01T00:00:00Z" }, NOW));
});

test("ranks only eligible wallets, ties share a rank; why lines read plainly", () => {
  const z = { tokens: 1, verifiedHolders: 0, holders: 0, feesUsd: 0, dumped: 0 };
  const sc = { early: 0, holds: 0, feesUsd: 0 };
  const scores = [
    { wallet: "a", creator: 50, scout: 0, total: 50, creatorWhy: { ...z, verifiedHolders: 2, holders: 1, feesUsd: 12.5 }, scoutWhy: sc },
    { wallet: "b", creator: 50, scout: 0, total: 50, creatorWhy: z, scoutWhy: sc },
    { wallet: "c", creator: 90, scout: 0, total: 90, creatorWhy: z, scoutWhy: sc },
  ];
  assert.deepEqual([...rankBy(scores, "creator", new Set(["a", "b"])).entries()], [["a", 1], ["b", 1]]);
  assert.equal(whyLine("creator", scores[0]), "2 verified holders · 1 holder · $12.50 fees from verified traders");
});

// ── review on PR 85 ──────────────────────────────────────────────────────────
test("dump through a side wallet: moving the bought tokens out in the season and selling elsewhere is a dump too", () => {
  const b = buyer(w(1), START + DAY, 0.01);
  const bought = new Map([[L.key, [{ tx: "0xcb", tokenRaw: 1_000_000n * E18 }]]]);
  const boughtIn: Move = { key: L.key, wallet: CREATOR, block: 50, logIndex: 1, tx: "0xcb", delta: 1_000_000n * E18 };
  const toSide: Move = { key: L.key, wallet: CREATOR, block: 3000, logIndex: 5, tx: "0xside", delta: -700_000n * E18 }; // no swap by the creator
  const sideSell: ScoreSwap = { key: L.key, trader: "0xside", isBuy: false, quoteRaw: eth(0.1), tokenRaw: 700_000n * E18, block: 3001, logIndex: 1, time: START + 2 * DAY, tx: "0xss" };
  const r = scoreSeason(build([b], { swaps: [b.swap, sideSell], launcherBuys: bought, moves: [...b.moves, boughtIn, toSide] }));
  assert.equal(r.wallets.get(CREATOR)?.creator ?? 0, 0);
  // the same transfer before the season is no dump of this season
  const early: Move = { ...toSide, block: 500 }; // the season starts at block 1,000 in these tests
  const r2 = scoreSeason(build([b], { swaps: [b.swap], launcherBuys: bought, moves: [...b.moves, boughtIn, early] }));
  assert.ok((r2.wallets.get(CREATOR)?.creator ?? 0) > 0, "moved before the season: this season's points stand");
  // burning them is not moving them out
  const burned = scoreSeason(build([b], { swaps: [b.swap], launcherBuys: bought, moves: [...b.moves, boughtIn, { ...toSide, burn: true }] }));
  assert.ok((burned.wallets.get(CREATOR)?.creator ?? 0) > 0, "a burn is no dump");
});

test("best 3 per launch day are ranked with the fee cap applied: one big fee payer cannot push out real holders", () => {
  const launches = ["0xa", "0xb", "0xc", "0xd"].map((t, i) => ({ ...L, key: `base:${t}`, launchTime: START - DAY + i }));
  // 0xa: one eligible trader paying $20 of fees in a day (200 points uncapped, 50 capped), no holders worth more
  const whale = buyer(w(900), START + DAY, 20 / 0.01 / 2000, 1, launches[0]); // $2,000 buy → $20 fee at 1%
  // 0xb..0xd: 3 eligible holders each (45 each after a week): 135 apiece. 0xa is worth 45 (the whale holds) + 50
  // (its fees capped) = 95; ranked uncapped it looked like 245 and pushed one of the 135s out
  const fans = [3, 3, 3].flatMap((count, i) => Array.from({ length: count }, (_, j) => buyer(w(100 * (i + 1) + j), START + DAY, 0.003, 1, launches[i + 1])));
  const eligible = new Set([w(900), ...fans.map((f) => f.first.wallet)]);
  const r = scoreSeason(build([whale, ...fans], { launches, eligible }));
  const c = r.wallets.get(CREATOR)!;
  assert.equal(c.creatorWhy.tokens, 3);
  // the true best three are 0xb, 0xc and 0xd (3 × 135 = 405, plus their holders' own small fees), not 0xa's 95
  assert.ok(c.creator >= 405, `creator ${c.creator}`);
  assert.equal(c.creatorWhy.verifiedHolders, 9, "every fan counted; the whale's token was the one cut");
});

test("holds come only from a token the wallet first bought in the season (with a real first buy)", () => {
  // held from before the season, bought again in it: no hold point for the second buy
  const before = buyer(w(1), START - DAY, 0.003);
  const again = buyer(w(1), START + DAY, 0.003);
  const r = scoreSeason(input({ swaps: [before.swap, again.swap], firstBuys: [before.first], moves: [...before.moves, ...again.moves] }));
  assert.equal(r.wallets.get(w(1))?.scoutWhy.holds ?? 0, 0);
  // a first buy that was not a real one (under $5), then a real-sized buy: still no hold point
  const tiny = buyer(w(2), START + DAY, 0.001); // $2
  const bigger = buyer(w(2), START + 2 * DAY, 0.003);
  const r2 = scoreSeason(input({ swaps: [tiny.swap, bigger.swap], firstBuys: [tiny.first], moves: [...tiny.moves, ...bigger.moves] }));
  assert.equal(r2.wallets.get(w(2))?.scoutWhy.holds ?? 0, 0);
});

test("a buy whose tokens the wallet never received (a relayer or bundler the swap was credited to) is no real buy", () => {
  const real = Array.from({ length: 52 }, (_, i) => buyer(w(i + 1), START + DAY + 100 + i, 0.003, 1, L, 1100 + i));
  // a relayer credited with 25 early swaps: the tokens went to someone else, so no move into the relayer
  const relayed = Array.from({ length: 25 }, (_, i) => {
    const b = buyer(`0xrelay${i}`, START + DAY + i, 0.003, 1, L, 1000 + i);
    return { ...b, moves: b.moves.map((m) => ({ ...m, wallet: `0xuser${i}` })) };
  });
  const r = scoreSeason(build([...relayed, ...real]));
  assert.equal(r.wallets.get("0xrelay0")?.scoutWhy.early ?? 0, 0, "the relayer takes no early slot");
  assert.equal(r.wallets.get(w(1))!.scoutWhy.early, 1, "the first real buyers keep theirs");
});

test("best 3 by what each token adds: three tokens sharing one trader's fee cap are worth one cap, not three", () => {
  const launches = ["0xa", "0xb", "0xc", "0xd"].map((t, i) => ({ ...L, key: `base:${t}`, launchTime: START - DAY + i }));
  // one eligible trader buys $1,000 of each of 0xa..0xc on the same day ($10 fee each: 100 points uncapped, 50 capped,
  // and 50 for the three together); 0xd has one eligible holder (45 after a week)
  const whale = launches.slice(0, 3).map((l) => buyer(w(900), START + DAY, 0.5, 1, l));
  const fan = buyer(w(901), START + DAY, 0.003, 1, launches[3]);
  const r = scoreSeason(build([...whale, fan], { launches, eligible: new Set([w(900), w(901)]) }));
  const c = r.wallets.get(CREATOR)!;
  // the whale counts once as a holder (45) and once for fees (50); 0xd's fan adds 45 more
  assert.equal(c.creatorWhy.verifiedHolders, 2, "0xd's holder is counted: 0xd was not cut for a second share of the same cap");
  assert.ok(c.creator >= 45 + 50 + 45, `creator ${c.creator}`);
});
