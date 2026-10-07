import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeedItem } from "./queries";
import { feedKey } from "./river.ts";
import {
  FRESH_MS, FX_LIFE_MS, MAX_CASCADE_MS, PIP_CAP, PIP_STEP_MS, STEP_MS, STREAK_GAP_MS, STREAK_SHOW_MS,
  applyPlan, bumpOf, cascadeMs, chipText, lastTradeAt, mergeTape, pipFromSwapRow, pipMagnitude, planHits, rankMoves, streakOf, swapKey, tapeOrNone,
  type Pip, type TapePip,
} from "./trending-live.ts";

const NOW = 1_800_000_000_000;
const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const C = "0x" + "c3".repeat(20);
const OTHER = "0x" + "d4".repeat(20);
const board = [`base:${A}`, `base:${B}`, `robinhood:${C}`];

let n = 0;
type SwapOpts = { chain?: string; token?: string; usd?: number | null; buy?: boolean; dev?: boolean; ageMs?: number; tx?: string; log?: number };
/** A swap as the live feed delivers it. */
function swap(o: SwapOpts = {}): FeedItem {
  const i = ++n;
  return {
    kind: "swap", chain: (o.chain ?? "base") as "base", at: new Date(NOW - (o.ageMs ?? 1_000)).toISOString(), tx_hash: o.tx ?? `0x${i.toString(16).padStart(64, "0")}`,
    log_index: o.log ?? 1, token: o.token ?? A, name: "Token", symbol: "TKN", trader: "0x1", is_buy: o.buy ?? true, is_dev: o.dev ?? false,
    quote_wei: "1", quote_key: "eth", quote_symbol: "ETH", quote_decimals: 18, usd: o.usd === undefined ? 25 : o.usd, image_url: null,
  } as FeedItem;
}
const launch = (): FeedItem => ({ kind: "launch", chain: "base", at: new Date(NOW).toISOString(), tx_hash: "0xaa", token: OTHER, name: "L", symbol: "L", launcher: "0x1", lp_fee: 0, quote_key: "eth", image_url: null } as FeedItem);
const plan = (feed: FeedItem[], seen: string[] = []) => planHits({ feed, seen: new Set(seen), board, at: NOW });

test("a swap key is spelled the way the river spells it, so the seed and the feed agree on one trade", () => {
  const s = swap() as Extract<FeedItem, { kind: "swap" }>;
  assert.equal(swapKey(s.chain, s.tx_hash, s.token, s.log_index), feedKey(s));
});

test("the first poll is a baseline: trades already seen are never news", () => {
  const feed = [swap(), swap({ buy: false }), swap({ token: B })];
  const baseline = new Set(feed.map((item) => feedKey(item)));
  const p = plan(feed, [...baseline]);
  assert.deepEqual(p.hits, []);
  assert.deepEqual(p.silent, {});
});

test("a new trade on a card is one hit: slot 0, a pip that springs in, the card's side and size", () => {
  const p = plan([swap({ usd: 45 })]);
  assert.equal(p.hits.length, 1);
  const hit = p.hits[0];
  assert.deepEqual([hit.token, hit.side, hit.slot, hit.buys, hit.sells], [`base:${A}`, "buy", 0, { n: 1, usd: 45 }, { n: 0, usd: null }]);
  assert.equal(hit.pips.length, 1);
  assert.deepEqual(hit.pips[0].fresh, { slot: 0, since: NOW });
  assert.ok(Math.abs(hit.mag - Math.log10(46)) < 1e-9);
  assert.deepEqual(p.silent, {});
});

test("an event that arrives twice (two servers, a re-sent poll) reacts once", () => {
  const item = swap();
  const first = plan([item]);
  assert.equal(first.hits.length, 1);
  const again = plan([item], [...first.seen]);
  assert.deepEqual(again.hits, []);
});

test("two trades in the same second on one card are both counted: events are told apart by key, not by time", () => {
  const same = new Date(NOW - 2_000).toISOString();
  const a = { ...(swap({ usd: 5 }) as object), at: same } as FeedItem;
  const b = { ...(swap({ usd: 777 }) as object), at: same } as FeedItem;
  const first = plan([a]);
  const second = plan([b, a], [...first.seen]);
  assert.equal(second.hits.length, 1);
  assert.deepEqual(second.hits[0].buys, { n: 1, usd: 777 });
});

test("tokens off the board and launches are not news", () => {
  const p = plan([swap({ token: OTHER }), launch()]);
  assert.deepEqual(p.hits, []);
  assert.deepEqual(p.silent, {});
});

test("an old trade (a tab waking up) only joins the tape, silently", () => {
  const p = plan([swap({ ageMs: FRESH_MS + 1_000 })]);
  assert.deepEqual(p.hits, []);
  assert.equal(p.silent[`base:${A}`].length, 1);
});

test("dust under a dollar alone ticks the tape and nothing else; beside a real trade it joins that hit", () => {
  const dust = plan([swap({ usd: 0.4 })]);
  assert.deepEqual(dust.hits, []);
  assert.equal(dust.silent[`base:${A}`].length, 1);
  const mixed = plan([swap({ usd: 0.4 }), swap({ usd: 30 })]);
  assert.equal(mixed.hits.length, 1);
  assert.deepEqual(mixed.hits[0].buys, { n: 1, usd: 30 }, "the chip counts the trades that are news");
  assert.equal(mixed.hits[0].pips.length, 2, "the tape shows both");
});

test("the cards of one poll take their turns in board order, STEP_MS apart, inside MAX_CASCADE_MS", () => {
  const p = plan([swap({ token: C, chain: "robinhood" }), swap({ token: B }), swap({ token: A })]);
  assert.deepEqual(p.hits.map((h) => [h.token, h.slot]), [[`base:${A}`, 0], [`base:${B}`, STEP_MS], [`robinhood:${C}`, 2 * STEP_MS]]);
  const many = ["a", "b", "c", "d", "e", "f"].map((_, i) => `base:0x${String(i).repeat(40)}`);
  const big = planHits({ feed: many.map((t) => swap({ token: t.slice(5) })), seen: new Set(), board: many, at: NOW });
  assert.ok(big.hits.every((h) => h.slot <= MAX_CASCADE_MS - STEP_MS));
  // no two cards react closer than STEP_MS unless the cap was reached
  const slots = big.hits.map((h) => h.slot);
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i] - slots[i - 1] >= STEP_MS || slots[i] === MAX_CASCADE_MS - STEP_MS);
});

test("several trades on one card in one poll fold into one hit; its pips spring in one after another", () => {
  const p = plan([swap({ usd: 12 }), swap({ usd: 40 }), swap({ usd: 90, buy: false })]);
  assert.equal(p.hits.length, 1);
  const hit = p.hits[0];
  assert.deepEqual([hit.buys, hit.sells, hit.side], [{ n: 2, usd: 52 }, { n: 1, usd: 90 }, "sell"]);
  assert.deepEqual(hit.pips.map((x) => x.fresh?.slot), [0, PIP_STEP_MS, 2 * PIP_STEP_MS]);
});

test("the chip says what happened, in words that carry no sign and no promise", () => {
  assert.equal(chipText({ buys: { n: 1, usd: 45 }, sells: { n: 0, usd: null }, dev: false }), "Buy $45");
  assert.equal(chipText({ buys: { n: 0, usd: null }, sells: { n: 1, usd: 303.65 }, dev: false }), "Sell $304");
  assert.equal(chipText({ buys: { n: 3, usd: 210 }, sells: { n: 0, usd: null }, dev: false }), "3 buys $210");
  assert.equal(chipText({ buys: { n: 2, usd: 50 }, sells: { n: 1, usd: 20 }, dev: false }), "2 buys $50 · Sell $20");
  assert.equal(chipText({ buys: { n: 1, usd: null }, sells: { n: 0, usd: null }, dev: false }), "Buy", "an unpriced trade has no figure");
  assert.equal(chipText({ buys: { n: 0, usd: null }, sells: { n: 2, usd: 8_400 }, dev: true }), "2 sells $8.4K · creator");
});

test("an unpriced trade is news, sized as a small one", () => {
  const p = plan([swap({ usd: null })]);
  assert.equal(p.hits.length, 1);
  assert.deepEqual(p.hits[0].buys, { n: 1, usd: null });
  assert.equal(pipMagnitude(null), 1);
});

test("the pip scale is the river's: $1 is small, $100 is 2, $10K and up is 4", () => {
  assert.ok(Math.abs(pipMagnitude(1) - Math.log10(2)) < 1e-9);
  assert.ok(Math.abs(pipMagnitude(99) - 2) < 1e-9);
  assert.equal(pipMagnitude(1e9), 4);
  assert.equal(pipMagnitude(-5), 0);
});

test("the tape keeps one pip per key, oldest first, at most the cap", () => {
  const pip = (i: number, key = `k${i}`): TapePip => ({ key, at: NOW + i * 1_000, buy: i % 2 === 0, usd: 10, dev: false });
  const merged = mergeTape([pip(2), pip(0)], [pip(1), pip(2)]);
  assert.deepEqual(merged.map((p) => p.key), ["k0", "k1", "k2"]);
  const fresh: TapePip = { ...pip(0), fresh: { slot: 0, since: NOW } };
  assert.equal(mergeTape([pip(0)], [fresh])[0].fresh, undefined, "the pip already on the tape wins: it does not replay");
  const long = mergeTape(undefined, Array.from({ length: PIP_CAP + 10 }, (_, i) => pip(i)));
  assert.equal(long.length, PIP_CAP);
  assert.equal(long[long.length - 1].key, `k${PIP_CAP + 9}`);
});

test("a streak is a run of same-side trades with gaps under 20 s, shown for a minute after the last", () => {
  const at = (s: number) => NOW - s * 1_000;
  const pips: Pip[] = [
    { key: "a", at: at(300), buy: true, usd: 5, dev: false },
    { key: "b", at: at(50), buy: true, usd: 5, dev: false },
    { key: "c", at: at(40), buy: true, usd: 5, dev: false },
    { key: "d", at: at(30), buy: true, usd: 5, dev: false },
  ];
  assert.deepEqual(streakOf(pips, NOW), { side: "buy", n: 3 }, "the 250 s gap before b ends the run");
  assert.equal(streakOf(pips, NOW + STREAK_SHOW_MS), null, "a minute after the last trade the tag is gone");
  assert.equal(streakOf([...pips, { key: "e", at: at(10), buy: false, usd: 5, dev: false }], NOW), null, "a trade on the other side ends it");
  assert.equal(streakOf(pips.slice(0, 1), NOW), null, "one trade is not a streak");
  assert.equal(streakOf([{ key: "a", at: at(50), buy: false, usd: 5, dev: false }, { key: "b", at: at(50) + STREAK_GAP_MS + 1, buy: false, usd: 5, dev: false }], NOW), null);
  assert.equal(streakOf([], NOW), null);
});

test("rank moves are places gained (positive) or lost, for tokens that were on the board and are still", () => {
  assert.deepEqual(rankMoves(["a", "b", "c", "d"], ["b", "a", "c", "e"]), { b: 1, a: -1 });
  assert.deepEqual(rankMoves(["a", "b"], ["a", "b"]), {});
  assert.deepEqual(rankMoves([], ["a"]), {});
});

test("a poll's cascade lasts until its last card has settled", () => {
  assert.equal(cascadeMs([]), 0);
  assert.equal(cascadeMs([{ slot: 0 }, { slot: 700 }]), 700 + 700);
});

test("applying a plan: pips join the tape, a reaction replaces the last one, the old ones age out", () => {
  const empty = { tape: {}, fx: {}, flips: {} };
  const first = applyPlan(empty, plan([swap({ usd: 45 })]), NOW);
  const t = `base:${A}`;
  assert.equal(first.tape[t].length, 1);
  assert.ok(first.tape[t][0].fresh);
  assert.deepEqual([first.fx[t].side, first.fx[t].chip, first.fx[t].parity, first.fx[t].slot], ["buy", "Buy $45", 0, 0]);
  // the next hit on the same card plays the other nudge keyframes, so the nudge replays at once
  const second = applyPlan(first, plan([swap({ usd: 60, buy: false })]), NOW + 5_000 - 1);
  assert.equal(second.fx[t].parity, 1);
  assert.equal(second.fx[t].chip, "Sell $60");
  assert.equal(applyPlan(second, plan([swap({ usd: 5 })]), NOW + 5_000).fx[t].parity, 0);
  // a poll later with no news: the reaction and the fresh flag of the old pip are gone, the tape stays
  const quiet = applyPlan(second, { hits: [], silent: {} }, NOW + 5_000 - 1 + FX_LIFE_MS);
  assert.deepEqual(quiet.fx, {});
  assert.ok(quiet.tape[t].every((p) => !p.fresh));
  assert.equal(quiet.tape[t].length, 2);
  assert.equal(quiet.flips[t], 1, "the parity outlives the reaction, so the next nudge still alternates");
});

test("applying a plan with the board's tokens forgets the ones that left it", () => {
  const both = applyPlan({ tape: {}, fx: {}, flips: {} }, plan([swap({ token: A }), swap({ token: B })]), NOW, board);
  assert.deepEqual(Object.keys(both.tape).sort(), [`base:${A}`, `base:${B}`]);
  const after = applyPlan(both, { hits: [], silent: {} }, NOW + 1_000, [`base:${B}`]);
  assert.deepEqual(Object.keys(after.tape), [`base:${B}`]);
  assert.deepEqual(Object.keys(after.fx), [`base:${B}`]);
  assert.deepEqual(Object.keys(after.flips), [`base:${B}`]);
});

test("the nudge grows with the trade and is capped: 0.9% on the leader, 1.2% on a runner", () => {
  assert.ok(bumpOf(0, true) < bumpOf(2, true) && bumpOf(2, true) < bumpOf(4, true));
  assert.equal(bumpOf(4, true), 0.009);
  assert.equal(bumpOf(4, false), 0.012);
  assert.equal(bumpOf(99, false), 0.012);
  assert.ok(bumpOf(-3, true) > 0);
  assert.ok(bumpOf(1, false) > bumpOf(1, true), "a runner moves a little more than the leader");
});

test("a tape row from the database is priced and filtered the way the feed does it", () => {
  const info = { launcher: A, quote_usd: 3_000, quote_decimals: 18 };
  const row = { chain: "base", token: B, tx_hash: "0xabc", log_index: 7, is_buy: false, quote_wei: String(10n ** 16n), at: new Date(NOW).toISOString(), trader: A.toUpperCase().replace("0X", "0x") };
  const pip = pipFromSwapRow(row, info)!;
  assert.equal(pip.key, `base:swap:0xabc:${B}:7`);
  assert.equal(pip.usd, 30);
  assert.equal(pip.dev, true, "the launcher's own trade is marked, whatever the address casing");
  assert.equal(pip.buy, false);
  assert.equal(pipFromSwapRow({ ...row, quote_wei: "1" }, info), null, "a one-wei swap is dust");
  assert.equal(pipFromSwapRow({ ...row, at: "not a date" }, info), null);
  assert.equal(pipFromSwapRow(row, { ...info, quote_usd: null })!.usd, null, "no price, no dollars, still a trade");
});

test("a token's last trade is the later of its row's times and the newest pip on its tape", () => {
  const row = { last_trade_at: new Date(NOW - 600_000).toISOString(), last_outside_trade_at: new Date(NOW - 900_000).toISOString() };
  assert.equal(lastTradeAt(row, []), NOW - 600_000);
  assert.equal(lastTradeAt({ last_trade_at: null, last_outside_trade_at: new Date(NOW - 5_000).toISOString() }, []), NOW - 5_000, "the outside time counts when it is the later one");
  const pip: Pip = { key: "k", at: NOW - 3_000, buy: true, usd: 9, dev: false };
  assert.equal(lastTradeAt(row, [pip]), NOW - 3_000, "a trade on the tape beats a row that has not caught up");
  assert.equal(lastTradeAt({ last_trade_at: null, last_outside_trade_at: null }, []), null);
});

test("a failed tape read leaves the cards without tapes instead of failing the page", async () => {
  const tape = { "8453:0xa": [{ key: "k", at: NOW, buy: true, usd: 5, dev: false }] };
  assert.deepEqual(await tapeOrNone(async () => tape, () => assert.fail("no error to report")), tape);
  const seen: unknown[] = [];
  assert.equal(await tapeOrNone(async () => { throw new Error("timeout"); }, (e) => seen.push(e)), undefined);
  assert.equal((seen[0] as Error).message, "timeout", "the error is handed on to be logged");
  assert.equal(await tapeOrNone(() => { throw new Error("sync"); }, (e) => seen.push(e)), undefined, "a read that throws before it returns a promise too");
  assert.equal(seen.length, 2);
});
