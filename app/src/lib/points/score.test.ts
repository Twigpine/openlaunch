import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES, rankBy, scoreSeason, whyLine, type FirstBuy, type ScoreInput, type ScoreLaunch, type ScoreSwap } from "./score.ts";

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1);
const NOW = START + 10 * DAY;
const CREATOR = "0xc0";
const RECIP = "0xfe";
const E18 = 10n ** 18n;
const eth = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // n ETH in wei
const w = (i: number) => `0x${i.toString(16).padStart(4, "0")}`;

// a token launched before the season: quote ETH at $2,000, 1% fee, token price $0.001
const L: ScoreLaunch = { key: "base:0xt1", launcher: CREATOR, recipients: [RECIP], launchBlock: 100, launchTime: START - 30 * DAY, lpFee: 10_000, quoteDecimals: 18, quoteUsd: 2000, tokenUsd: 0.001 };

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    seasonStart: START,
    seasonEnd: START + 28 * DAY,
    now: NOW,
    launches: [L],
    swaps: [],
    firstBuys: [],
    holders: [],
    launcherBought: new Map(),
    linked: new Map(),
    system: new Set(["0xpool"]),
    eligible: new Set(),
    flagged: new Set(),
    maxOutsideBefore: new Map(),
    ...over,
  };
}
/** a buyer who bought at `t`, spent `ethIn`, and holds `tokens` whole tokens now */
function buyer(wallet: string, t: number, ethIn: number, tokens: number, block = 1000) {
  const s: ScoreSwap = { key: L.key, trader: wallet, isBuy: true, quoteRaw: eth(ethIn), tokenRaw: BigInt(tokens) * E18, block, time: t };
  const f: FirstBuy = { key: L.key, wallet, block, time: t, quoteRaw: eth(ethIn) };
  return { swap: s, first: f, holder: { key: L.key, wallet, balanceRaw: BigInt(tokens) * E18 } };
}
function build(buyers: ReturnType<typeof buyer>[], over: Partial<ScoreInput> = {}) {
  return input({ swaps: buyers.map((b) => b.swap), firstBuys: buyers.map((b) => b.first), holders: buyers.map((b) => b.holder), ...over });
}

test("an eligible holder who bought this season and held a day earns the creator 30; unverified 5", () => {
  const b1 = buyer(w(1), START + DAY, 0.01, 5000); // $20 spent, $5 held
  const b2 = buyer(w(2), START + DAY, 0.01, 5000);
  const r = scoreSeason(build([b1, b2], { eligible: new Set([w(1)]) }));
  const c = r.wallets.get(CREATOR)!;
  // 30 × 1.5 (held 9 days ≥ 7) + 5 × 1.5 + fees: 2 × $20 × 1% × 10
  assert.equal(c.creatorWhy.verifiedHolders, 1);
  assert.equal(c.creatorWhy.holders, 1);
  assert.equal(c.creator, Math.round(45 + 7.5 + 2 * 20 * 0.01 * 10));
});

test("holders gained before the season, held under a day, or holding dust earn nothing", () => {
  const before = buyer(w(1), START - DAY, 0.01, 5000);
  const fresh = buyer(w(2), NOW - 3_600_000, 0.01, 5000);
  const dust = buyer(w(3), START + DAY, 0.01, 1000); // $1 held, unverified needs $5
  const r = scoreSeason(build([before, fresh, dust]));
  const c = r.wallets.get(CREATOR);
  assert.equal(c?.creatorWhy.holders ?? 0, 0);
});

test("the creator, fee recipients, transfer-fed wallets and snipers are never outside", () => {
  const self = buyer(CREATOR, START + DAY, 1, 50000);
  const recip = buyer(RECIP, START + DAY, 1, 50000);
  const sock = buyer(w(9), START + DAY, 1, 50000);
  const sniper = buyer(w(8), START + DAY, 1, 50000, L.launchBlock + 2);
  const r = scoreSeason(build([self, recip, sock, sniper], { linked: new Map([[L.key, new Set([w(9)])]]), eligible: new Set([w(9), w(8)]) }));
  assert.equal(r.wallets.get(CREATOR)?.creator ?? 0, 0, "no holder points and no fee points from insiders");
});

test("wash trading your own token earns nothing; a 0% fee token earns no fee points", () => {
  const wash = Array.from({ length: 20 }, (_, i) => ({ key: L.key, trader: CREATOR, isBuy: i % 2 === 0, quoteRaw: eth(5), tokenRaw: 1000n * E18, block: 2000 + i, time: START + DAY + i }));
  assert.equal(scoreSeason(input({ swaps: wash })).wallets.get(CREATOR)?.creator ?? 0, 0);
  const free = { ...L, lpFee: 0 };
  const b = buyer(w(1), START + DAY, 1, 1);
  assert.equal(scoreSeason(build([b], { launches: [free], holders: [] })).wallets.get(CREATOR)?.creatorWhy.feesUsd ?? 0, 0);
});

test("a creator who sold half of what they bought this season scores 0 for that token; selling fee tokens alone is fine", () => {
  const b = buyer(w(1), START + DAY, 0.5, 5000);
  const dump: ScoreSwap = { key: L.key, trader: CREATOR, isBuy: false, quoteRaw: eth(1), tokenRaw: 600n * E18, block: 3000, time: START + 2 * DAY };
  const dumped = scoreSeason(build([b], { swaps: [b.swap, dump], launcherBought: new Map([[L.key, 1000n * E18]]) }));
  assert.equal(dumped.wallets.get(CREATOR)?.creator ?? 0, 0);
  assert.equal(dumped.wallets.get(CREATOR)?.creatorWhy.dumped, 1);
  const feeSale = scoreSeason(build([b], { swaps: [b.swap, dump] })); // never bought: those were fee tokens
  assert.ok((feeSale.wallets.get(CREATOR)?.creator ?? 0) > 0);
});

test("only the best 3 tokens a wallet launched on one day count", () => {
  const launches = Array.from({ length: 5 }, (_, i) => ({ ...L, key: `base:0xt${i}`, launchTime: START + DAY + i }));
  const swaps: ScoreSwap[] = launches.map((l, i) => ({ key: l.key, trader: w(i + 1), isBuy: true, quoteRaw: eth(0.01 * (i + 1)), tokenRaw: E18, block: 5000, time: START + 2 * DAY }));
  const r = scoreSeason(input({ launches, swaps }));
  assert.equal(r.wallets.get(CREATOR)!.creatorWhy.tokens, 3);
  // fees: $20, $40 … $100 at 1% → 2, 4, 6, 8, 10 points; best three = 10 + 8 + 6
  assert.equal(r.wallets.get(CREATOR)!.creator, 24);
});

test("alive at day 7: a week old, 10+ outside holders, an outside trade in the last day", () => {
  const holders = Array.from({ length: 10 }, (_, i) => buyer(w(i + 1), NOW - 2 * 3_600_000, 0.01, 5000));
  const r = scoreSeason(build(holders));
  assert.equal(r.wallets.get(CREATOR)!.creatorWhy.alive, 1);
});

test("early: the first 25 outside buyers of a token that reached 50 holders, +50 while holding", () => {
  const buyers = Array.from({ length: 30 }, (_, i) => buyer(w(i + 1), START + DAY + i * 1000, 0.01, i === 0 ? 0 : 5000, 1000 + i));
  const inp = build(buyers, { maxOutsideBefore: new Map([[L.key, 50]]) });
  const r = scoreSeason(inp);
  assert.equal(r.wallets.get(w(1))!.scoutWhy.early, 1);
  assert.equal(r.wallets.get(w(2))!.scout - r.wallets.get(w(1))!.scout, RULES.earlyStillHolding + RULES.hold, "w(1) sold: no +50 and no hold");
  assert.equal(r.wallets.get(w(26))?.scoutWhy.early ?? 0, 0, "26th buyer is not early");
  const small = scoreSeason(build(buyers));
  assert.equal(small.wallets.get(w(2))?.scoutWhy.early ?? 0, 0, "token never reached 50: nobody is early");
});

test("holds: ≥ $5 buy still held a day later, at most 20 tokens per day", () => {
  const launches = Array.from({ length: 25 }, (_, i) => ({ ...L, key: `base:0xh${i}` }));
  const swaps = launches.map((l) => ({ key: l.key, trader: w(1), isBuy: true, quoteRaw: eth(0.01), tokenRaw: 5000n * E18, block: 5000, time: START + DAY }));
  const holders = launches.map((l) => ({ key: l.key, wallet: w(1), balanceRaw: 5000n * E18 }));
  const r = scoreSeason(input({ launches, swaps, holders }));
  assert.equal(r.wallets.get(w(1))!.scoutWhy.holds, RULES.holdTokensPerDay);
  const tiny = scoreSeason(input({ launches: [L], swaps: [{ ...swaps[0], key: L.key, quoteRaw: eth(0.001) }], holders: [{ key: L.key, wallet: w(1), balanceRaw: E18 }] }));
  assert.equal(tiny.wallets.get(w(1))?.scoutWhy.holds ?? 0, 0, "$2 buy earns nothing");
});

test("scout fee points only on tokens with 20+ outside holders, capped per token per day", () => {
  const big: ScoreSwap[] = Array.from({ length: 40 }, (_, i) => ({ key: L.key, trader: w(1), isBuy: i % 2 === 0, quoteRaw: eth(1), tokenRaw: E18, block: 6000 + i, time: START + 2 * DAY + i }));
  const r = scoreSeason(input({ swaps: big, maxOutsideBefore: new Map([[L.key, 20]]) }));
  assert.equal(Math.round(r.wallets.get(w(1))!.scout), RULES.scoutFeeCapPerTokenDay);
  const r2 = scoreSeason(input({ swaps: big }));
  assert.equal(r2.wallets.get(w(1))?.scout ?? 0, 0, "token without 20 outside holders");
});

test("a wallet kept off points scores nothing and counts for no one", () => {
  const b = buyer(w(1), START + DAY, 0.01, 5000);
  const r = scoreSeason(build([b], { flagged: new Set([w(1)]), eligible: new Set([w(1)]) }));
  assert.equal(r.wallets.has(w(1)), false);
  assert.equal(r.wallets.get(CREATOR)?.creatorWhy.verifiedHolders ?? 0, 0);
});

test("unpriced quotes: holders count without a dollar floor, fees earn nothing", () => {
  const unpriced = { ...L, quoteUsd: null, tokenUsd: null };
  const b = buyer(w(1), START + DAY, 0.0001, 1);
  const r = scoreSeason(build([b], { launches: [unpriced] }));
  assert.equal(r.wallets.get(CREATOR)!.creatorWhy.holders, 1);
  assert.equal(r.wallets.get(CREATOR)!.creatorWhy.feesUsd, 0);
});

test("ranks only eligible wallets, ties share a rank; why lines read plainly", () => {
  const scores = [
    { wallet: "a", creator: 50, scout: 0, total: 50, creatorWhy: { tokens: 1, verifiedHolders: 2, holders: 1, feesUsd: 12.5, alive: 1, dumped: 0 }, scoutWhy: { early: 0, holds: 0, feesUsd: 0 } },
    { wallet: "b", creator: 50, scout: 0, total: 50, creatorWhy: { tokens: 1, verifiedHolders: 0, holders: 0, feesUsd: 0, alive: 0, dumped: 0 }, scoutWhy: { early: 0, holds: 0, feesUsd: 0 } },
    { wallet: "c", creator: 90, scout: 0, total: 90, creatorWhy: { tokens: 1, verifiedHolders: 0, holders: 0, feesUsd: 0, alive: 0, dumped: 0 }, scoutWhy: { early: 0, holds: 0, feesUsd: 0 } },
  ];
  const ranks = rankBy(scores, "creator", new Set(["a", "b"]));
  assert.deepEqual([...ranks.entries()], [["a", 1], ["b", 1]], "c is not eligible");
  assert.equal(whyLine("creator", scores[0]), "2 verified holders · 1 holder · $12.50 fees · 1 alive at day 7");
});
