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

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return { seasonStart: START, seasonEnd: START + 28 * DAY, now: NOW, launches: [L], swaps: [], firstBuys: [], holders: [], launcherBought: new Map(), linked: new Map(), system: new Set(["0xpool"]), eligible: new Set(), flagged: new Set(), ...over };
}
let li = 0;
/** a wallet that bought `ethIn` at `t` and holds `keep` of it now */
function buyer(wallet: string, t: number, ethIn: number, keep = 1, launch: ScoreLaunch = L, block = 1000 + li) {
  li++;
  const tokenRaw = tokensFor(ethIn);
  const swap: ScoreSwap = { key: launch.key, trader: wallet, isBuy: true, quoteRaw: eth(ethIn), tokenRaw, block, logIndex: li, time: t };
  const first: FirstBuy = { key: launch.key, wallet, block, logIndex: li, time: t, quoteRaw: eth(ethIn), tokenRaw };
  return { swap, first, holder: { key: launch.key, wallet, balanceRaw: (tokenRaw * BigInt(Math.round(keep * 1000))) / 1000n } };
}
function build(buyers: ReturnType<typeof buyer>[], over: Partial<ScoreInput> = {}) {
  return input({ swaps: buyers.map((b) => b.swap), firstBuys: buyers.map((b) => b.first), holders: buyers.map((b) => b.holder), ...over });
}

// ── the rules ────────────────────────────────────────────────────────────────
test("a real holder who bought this season and held a day earns the creator 30 if eligible, 5 if not; half again after a week", () => {
  const b1 = buyer(w(1), START + DAY, 0.0025); // $5
  const b2 = buyer(w(2), NOW - 2 * DAY, 0.0025);
  const r = scoreSeason(build([b1, b2], { eligible: new Set([w(1)]) }));
  const c = r.wallets.get(CREATOR)!;
  assert.equal(c.creatorWhy.verifiedHolders, 1);
  assert.equal(c.creatorWhy.holders, 1);
  // fees come only from eligible traders: w(1)'s $5 at 1% = $0.05 → 0.5 points
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

test("dump: sold this season and now keeps under half of what was bought → the token scores 0; selling fee tokens is fine", () => {
  const b = buyer(w(1), START + DAY, 0.01);
  const sell: ScoreSwap = { key: L.key, trader: CREATOR, isBuy: false, quoteRaw: eth(0.1), tokenRaw: 500_000n * E18, block: 3000, logIndex: 1, time: START + 2 * DAY };
  const bought = new Map([[L.key, 1_000_000n * E18]]);
  const dumped = scoreSeason(build([b], { swaps: [b.swap, sell], launcherBought: bought, holders: [b.holder, { key: L.key, wallet: CREATOR, balanceRaw: 400_000n * E18 }] }));
  assert.equal(dumped.wallets.get(CREATOR)?.creator ?? 0, 0);
  const feeSale = scoreSeason(build([b], { swaps: [b.swap, sell], launcherBought: bought, holders: [b.holder, { key: L.key, wallet: CREATOR, balanceRaw: 1_000_000n * E18 }] }));
  assert.ok((feeSale.wallets.get(CREATOR)?.creator ?? 0) > 0, "sold 500k fee tokens but still keeps everything bought");
});

test("early: first 25 real buyers of a token with 50+ real holders; +50 only while half of that buy is held", () => {
  const buyers = Array.from({ length: 52 }, (_, i) => buyer(w(i + 1), START + DAY + i * 1000, 0.003, i === 0 ? 0.3 : 1, L, 1000 + i));
  const r = scoreSeason(build(buyers));
  assert.equal(r.realHolders.get(L.key), 52 - 1, "w(1) kept $1.80: not a real holder (unverified needs $5)");
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

test("holds: first buy ≥ $5 this season, half still held a day later; 20 tokens a day", () => {
  const launches = Array.from({ length: 25 }, (_, i) => ({ ...L, key: `base:0xh${i}` }));
  const buys = launches.map((l) => buyer(w(1), START + DAY, 0.003, 1, l));
  const r = scoreSeason(build(buys, { launches }));
  assert.equal(r.wallets.get(w(1))!.scoutWhy.holds, RULES.holdTokensPerDay);
  const soldDown = scoreSeason(build([buyer(w(2), START + DAY, 0.003, 0.4)]));
  assert.equal(soldDown.wallets.get(w(2))?.scoutWhy.holds ?? 0, 0, "sold down to 40%: no hold");
});

test("scout fees: net buyers on tokens with 20+ real holders (5+ eligible), at most 200 a day; round trips earn nothing", () => {
  const holders = Array.from({ length: 20 }, (_, i) => buyer(w(100 + i), START + DAY, 0.003));
  const eligible = new Set(holders.slice(0, 5).map((h) => h.first.wallet));
  // w(1) buys 1 ETH 30 times and keeps all of it: $20 fees each → capped at 200 points that day
  const buys: ScoreSwap[] = Array.from({ length: 30 }, (_, i) => ({ key: L.key, trader: w(1), isBuy: true, quoteRaw: eth(1), tokenRaw: tokensFor(1), block: 6000 + i, logIndex: i, time: START + 2 * DAY + i }));
  const kept = { key: L.key, wallet: w(1), balanceRaw: tokensFor(1) * 30n };
  const base = { swaps: [...holders.map((h) => h.swap), ...buys], firstBuys: holders.map((h) => h.first), holders: [...holders.map((h) => h.holder), kept], eligible };
  assert.equal(scoreSeason(input(base)).wallets.get(w(1))!.scoutWhy.feesUsd > 0, true);
  assert.equal(scoreSeason(input(base)).wallets.get(w(1))!.scout <= RULES.scoutFeeCapPerDay + RULES.hold, true);
  const roundTrip = scoreSeason(input({ ...base, holders: holders.map((h) => h.holder) })); // sold it all again
  assert.equal(roundTrip.wallets.get(w(1))?.scoutWhy.feesUsd ?? 0, 0, "a round trip earns no fee points");
  const fewEligible = scoreSeason(input({ ...base, eligible: new Set() }));
  assert.equal(fewEligible.wallets.get(w(1))?.scoutWhy.feesUsd ?? 0, 0, "a token without 5 eligible holders earns no scout fees");
  const thin = scoreSeason(input({ swaps: buys, holders: [kept] }));
  assert.equal(thin.wallets.get(w(1))?.scoutWhy.feesUsd ?? 0, 0, "no real holders: no scout fee points");
});

// ── the exploits the review found, as regressions ────────────────────────────
test("exploit: an unpriced quote (a farmer's own ERC-20) earns nothing at all", () => {
  const fake: ScoreLaunch = { ...L, key: "base:0xfake", quoteUsd: null, tokenUsd: null, launchTime: START + DAY };
  const socks = Array.from({ length: 50 }, (_, i) => buyer(w(i + 1), START + DAY + 60_000 + i, 1, 1, fake, 500 + i));
  const r = scoreSeason(build(socks, { launches: [fake], eligible: new Set([w(1)]) }));
  assert.equal(r.wallets.size, 0);
});

test("exploit: dust sent to 50 wallets makes none of them holders and unlocks nothing", () => {
  const scout = buyer(w(1), START + DAY, 0.0025, 0); // bought $5, sold to dust
  const dust = Array.from({ length: 50 }, (_, i) => ({ key: L.key, wallet: w(1000 + i), balanceRaw: 1n }));
  const r = scoreSeason(input({ swaps: [scout.swap], firstBuys: [scout.first], holders: [{ ...scout.holder, balanceRaw: 1n }, ...dust], eligible: new Set([w(1)]) }));
  assert.equal(r.realHolders.get(L.key) ?? 0, 0);
  assert.equal(r.wallets.get(w(1))?.scoutWhy.early ?? 0, 0);
  assert.equal(r.wallets.get(w(1))?.scoutWhy.holds ?? 0, 0);
});

test("exploit: wash trading earns nothing, verified or not; a verified net buyer gives the creator at most 50 a day", () => {
  const wash: ScoreSwap[] = Array.from({ length: 100 }, (_, i) => ({ key: L.key, trader: "0xpuppet", isBuy: i % 2 === 0, quoteRaw: eth(10), tokenRaw: tokensFor(10), block: 1000 + i, logIndex: i, time: START + 2 * DAY + i * 1000 }));
  assert.equal(scoreSeason(input({ swaps: wash })).wallets.get(CREATOR)?.creator ?? 0, 0);
  assert.equal(scoreSeason(input({ swaps: wash, eligible: new Set(["0xpuppet"]) })).wallets.get(CREATOR)?.creator ?? 0, 0, "round trips by a verified wallet: the fees come back, no points");
  const buys = wash.filter((x) => x.isBuy);
  const holding = { key: L.key, wallet: "0xpuppet", balanceRaw: tokensFor(10) * 50n };
  const net = scoreSeason(input({ swaps: buys, holders: [holding], eligible: new Set(["0xpuppet"]) }));
  assert.equal(net.wallets.get(CREATOR)!.creator, RULES.creatorFeeCapPerTraderDay, "$500 of buys still held: capital at stake, capped");
});

test("exploit: a wallet kept off points (deleted profile or not) scores nothing and counts for no one", () => {
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
