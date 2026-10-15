import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOOST_COPY,
  BOOST_DEAD,
  BOOST_FLOOR_TWIG,
  BOOST_LANE_SIZE,
  BOOST_PRESETS,
  BOOST_TOKEN,
  BOOST_WINDOW_MS,
  LAUNCH_TAG_MAX,
  TAG_SPACE,
  boostAmount,
  boostAmountProblem,
  boostConfirmLabel,
  boostExpiresAt,
  boostFromTransfer,
  boostFuse,
  boostIgnitions,
  boostShowsNow,
  compactWhole,
  IGNITE_FRESH_MS,
  boostTagOf,
  boostTimeLeft,
  boostWholeOf,
  buildBoostModMessage,
  fmtBoostTwig,
  groupWhole,
  isBoostModAction,
  isLaunchTag,
  maxBoostWhole,
  parseBoostWhole,
  rankLane,
  type BoostTransfer,
} from "./boost.ts";
import { TWIG_ADDRESS, TWIG_ADDRESSES } from "./twig.ts";
import { DEAD } from "./config.ts";

const E18 = 10n ** 18n;
const ID = 3_135_968n; // a real Base position id (the newest TWIG launch on 2026-10-14)

test("boosts burn TWIG on Base, to the dead address the rest of the app uses", () => {
  assert.equal(BOOST_TOKEN, TWIG_ADDRESS);
  assert.equal(BOOST_TOKEN, TWIG_ADDRESSES.base);
  assert.equal(BOOST_DEAD, DEAD.toLowerCase());
  assert.equal(BOOST_WINDOW_MS, 24 * 3_600_000);
  assert.equal(BOOST_LANE_SIZE, 5);
});

test("the amount carries the launch's position id in its last digits, and decodes back", () => {
  const raw = boostAmount(300_000n, ID);
  assert.equal(raw, 300_000n * E18 + ID);
  assert.equal(boostTagOf(raw), ID);
  assert.equal(boostWholeOf(raw), 300_000n);
  // the tag is worth under a millionth of one TWIG
  assert.ok(TAG_SPACE * 1_000_000n <= E18);
});

test("a tag must name a launch: positive and below the reserved range", () => {
  assert.equal(isLaunchTag(0n), false);
  assert.equal(isLaunchTag(1n), true);
  assert.equal(isLaunchTag(LAUNCH_TAG_MAX - 1n), true);
  assert.equal(isLaunchTag(LAUNCH_TAG_MAX), false);
  assert.throws(() => boostAmount(100_000n, 0n));
  assert.throws(() => boostAmount(100_000n, LAUNCH_TAG_MAX));
  assert.throws(() => boostAmount(0n, ID));
});

test("Max never asks for more than the balance holds, tag included", () => {
  assert.equal(maxBoostWhole(500_000n * E18 + ID, ID), 500_000n);
  assert.equal(maxBoostWhole(500_000n * E18 + ID - 1n, ID), 499_999n);
  assert.equal(maxBoostWhole(500_000n * E18, ID), 499_999n);
  assert.equal(maxBoostWhole(0n, ID), 0n);
  assert.equal(maxBoostWhole(E18 - 1n, ID), 0n);
  for (const bal of [123n * E18 + 5n, 10n ** 24n, 7n * E18 + ID, 7n * E18 + ID + 1n]) {
    const w = maxBoostWhole(bal, ID);
    if (w > 0n) assert.ok(boostAmount(w, ID) <= bal, `${bal}`);
    assert.ok(boostAmount(w + 1n, ID) > bal, `${bal}`);
  }
});

test("the amount box takes whole TWIG only", () => {
  assert.equal(parseBoostWhole("300000"), 300_000n);
  assert.equal(parseBoostWhole("1,000,000"), 1_000_000n);
  assert.equal(parseBoostWhole(" 5 000 000 "), 5_000_000n);
  for (const bad of ["", "0", "1.5", "-3", "1e6", "abc", "0x10", "1000000000000"]) assert.equal(parseBoostWhole(bad), null, bad);
  for (const p of BOOST_PRESETS) assert.ok((parseBoostWhole(p) ?? 0n) >= BOOST_FLOOR_TWIG, p);
});

test("the dialog names the one thing stopping a send", () => {
  assert.equal(boostAmountProblem(null, undefined, ID), "Enter a whole number of TWIG.");
  assert.equal(boostAmountProblem(99_999n, 10n ** 30n, ID), "A boost sends at least 100,000 TWIG.");
  assert.equal(boostAmountProblem(100_000n, 100_000n * E18, ID), "Not enough TWIG in this wallet.");
  assert.equal(boostAmountProblem(100_000n, 100_000n * E18 + ID, ID), null);
  assert.equal(boostAmountProblem(100_000n, undefined, ID), null); // balance still loading: the wallet will refuse if short
});

const transfer = (o: Partial<BoostTransfer> = {}): BoostTransfer => ({
  address: "0x6AC18BCF4EDE02591D4917452700EA5EAAEA13C1",
  from: "0xAbC0000000000000000000000000000000000001",
  to: "0x000000000000000000000000000000000000dEaD",
  value: 300_000n * E18 + ID,
  txHash: "0xAA".padEnd(66, "0"),
  logIndex: 7,
  blockNumber: 52_000_000n,
  ...o,
});

test("a TWIG transfer to 0x…dEaD with a launch tag becomes a boost row, lowercased", () => {
  assert.deepEqual(boostFromTransfer(transfer()), {
    tx_hash: "0xaa".padEnd(66, "0"),
    log_index: 7,
    booster: "0xabc0000000000000000000000000000000000001",
    amount: (300_000n * E18 + ID).toString(),
    tag: ID.toString(),
    block_number: "52000000",
  });
});

test("everything else is not a boost", () => {
  const LOCKER = "0x1111111111111111111111111111111111111111";
  assert.equal(boostFromTransfer(transfer({ address: "0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3" })), null, "GITLAWB, not TWIG");
  assert.equal(boostFromTransfer(transfer({ to: "0x0000000000000000000000000000000000000000" })), null, "unwrap burns go to zero");
  assert.equal(boostFromTransfer(transfer({ to: "0xabc0000000000000000000000000000000000002" })), null, "a plain transfer");
  assert.equal(boostFromTransfer(transfer({ from: LOCKER.toUpperCase().replace("0X", "0x") }), [LOCKER]), null, "the locker's own fee burn");
  assert.equal(boostFromTransfer(transfer({ value: 300_000n * E18 })), null, "no tag");
  assert.equal(boostFromTransfer(transfer({ value: 300_000n * E18 + LAUNCH_TAG_MAX + 5n })), null, "a reserved tag");
  assert.equal(boostFromTransfer(transfer({ value: (BOOST_FLOOR_TWIG - 1n) * E18 + ID })), null, "under the floor");
  assert.ok(boostFromTransfer(transfer({ value: BOOST_FLOOR_TWIG * E18 + ID })), "exactly the floor counts");
});

const row = (token: string, twig: bigint, lastAt: string) => ({ token, twig: (twig * E18).toString(), boosts: 1, boosters: 1, last_at: lastAt, last_tx: "0x" });

test("the lane orders by TWIG in the window, then the newer boost, then the address", () => {
  const ranked = rankLane([
    row("0xc", 100_000n, "2026-10-15T01:00:00Z"),
    row("0xa", 5_000_000n, "2026-10-15T00:00:00Z"),
    row("0xb", 100_000n, "2026-10-15T02:00:00Z"),
    row("0xe", 100_000n, "2026-10-15T01:00:00Z"),
    row("0xd", 300_000n, "2026-10-14T23:00:00Z"),
    row("0xf", 100_000n, "2026-10-14T00:00:00Z"),
  ]);
  assert.deepEqual(ranked.map((r) => r.token), ["0xa", "0xd", "0xb", "0xc", "0xe"]);
  assert.equal(rankLane([row("0xa", 1n, "2026-10-15T00:00:00Z")], 0).length, 0);
});

test("a boost runs 24 hours from the newest one, and says so", () => {
  const last = "2026-10-15T00:00:00.000Z";
  const t0 = Date.parse(last);
  assert.equal(boostExpiresAt(last), t0 + 24 * 3_600_000);
  assert.equal(boostTimeLeft(last, t0), "24h left");
  assert.equal(boostTimeLeft(last, t0 + 18.5 * 3_600_000), "5h left");
  assert.equal(boostTimeLeft(last, t0 + 23.25 * 3_600_000), "45m left");
  assert.equal(boostTimeLeft(last, t0 + 24 * 3_600_000 - 30_000), "under 1m left");
  assert.equal(boostTimeLeft(last, t0 + 24 * 3_600_000), null);
  assert.equal(boostTimeLeft("not a date", t0), null);
});

test("amounts read as people say them", () => {
  assert.equal(groupWhole(1_000_000n), "1,000,000");
  assert.equal(groupWhole(999n), "999");
  assert.equal(fmtBoostTwig(1_200_000n * E18 + ID), "1.2M TWIG");
  assert.equal(fmtBoostTwig(1_250_000n * E18), "1.25M TWIG");
  assert.equal(fmtBoostTwig(10_000_000n * E18), "10M TWIG");
  assert.equal(fmtBoostTwig((300_000n * E18 + ID).toString()), "300K TWIG");
  assert.equal(fmtBoostTwig(500n * E18), "500 TWIG");
  // never "1000K": a value that rounds up to the next unit takes it
  assert.equal(compactWhole(999_999), "1M");
  assert.equal(compactWhole(999_994), "999.99K");
  assert.equal(compactWhole(999_995_000), "1B");
  assert.equal(compactWhole(1_000), "1K");
  assert.equal(compactWhole(999), "999");
  assert.equal(fmtBoostTwig(999_999n * E18 + ID), "1M TWIG");
  assert.equal(boostConfirmLabel(300_000n), "Send 300,000 TWIG to 0x…dEaD");
});

test("an admin signature names the action, the token and the admin, and cannot pass for a posts signature", () => {
  assert.ok(isBoostModAction("hide") && isBoostModAction("unhide"));
  assert.equal(isBoostModAction("mute"), false);
  const m = buildBoostModMessage({ action: "hide", token: "0xABC", wallet: "0xDEF", nonce: "n1", ts: Date.parse("2026-10-15T00:00:00Z") });
  assert.equal(m, ["openlaunch.lol boosted lane", "", "Action: hide", "Token: base:0xabc", "Admin: 0xdef", "Nonce: n1", "Issued: 2026-10-15T00:00:00.000Z"].join("\n"));
  assert.ok(!m.includes("post:"));
});

test("the words keep to the rules: no value talk, the burn and its finality said plainly", () => {
  const banned = /\b(moon|rally|buyback|guarantee[ds]?|pump|gem|100x|profit|invest(ment)?|returns?|yield|airdrop|reward)\b/i;
  for (const [k, v] of Object.entries(BOOST_COPY)) assert.ok(!banned.test(v), `${k}: ${v}`);
  assert.match(BOOST_COPY.final, /cannot be undone or refunded/);
  assert.match(BOOST_COPY.laneNote, /Not a ranking/);
  assert.match(BOOST_COPY.what, /not an endorsement/);
});

test("the fuse is the share of the 24 hours still left", () => {
  const last = "2026-10-15T00:00:00.000Z";
  const t0 = Date.parse(last);
  assert.equal(boostFuse(last, t0), 1);
  assert.equal(boostFuse(last, t0 + 6 * 3_600_000), 0.75);
  assert.equal(boostFuse(last, t0 + 24 * 3_600_000), 0);
  assert.equal(boostFuse(last, t0 + 30 * 3_600_000), 0);
  assert.equal(boostFuse(last, t0 - 60_000), 1, "a clock behind the chain never overfills it");
  assert.equal(boostFuse("not a date", t0), 0);
});

test("a card lights up only for a fresh boost that added TWIG", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const item = (token: string, twig: bigint, msAgo: number) => ({ token, twig: (twig * E18).toString(), boosts: 1, boosters: 1, last_at: at(msAgo), last_tx: "0x" });
  const prev = new Map([["0xa", (100_000n * E18).toString()], ["0xb", (500_000n * E18).toString()]]);
  const lit = boostIgnitions(prev, [
    item("0xa", 400_000n, 10_000), // grew, fresh
    item("0xb", 500_000n, 10_000), // unchanged
    item("0xc", 300_000n, 20_000), // new to the lane, fresh
    item("0xd", 900_000n, 2 * 3_600_000), // new to the lane only because another expired: old boost
  ], now);
  assert.deepEqual([...lit].sort(), ["0xa", "0xc"]);
  assert.equal(boostIgnitions(null, [item("0xa", 1n, 0)], now).size, 0, "the first snapshot lights nothing");
  assert.equal(boostIgnitions(new Map(), [item("0xa", 1n, IGNITE_FRESH_MS + 1)], now).size, 0, "a tab back from sleep replays nothing");
  // fewer TWIG (an old boost aged out) is never news
  assert.equal(boostIgnitions(new Map([["0xa", (900_000n * E18).toString()]]), [item("0xa", 400_000n, 0)], now).size, 0);
});

test("the dialog knows whether a boost shows now", () => {
  const full = { full: true, cutoff: (1_000_000n * E18).toString() };
  assert.equal(boostShowsNow({ full: false, cutoff: null }, 0n, 100_000n * E18, false), true, "room in the lane");
  assert.equal(boostShowsNow(full, 0n, 100_000n * E18, false), false, "under the 5th place");
  assert.equal(boostShowsNow(full, 0n, 1_000_000n * E18, false), true, "a tie goes to the newer boost");
  assert.equal(boostShowsNow(full, 900_000n * E18, 100_000n * E18, false), true, "it adds to what the token already has");
  assert.equal(boostShowsNow(full, 0n, 1n, true), true, "already in the lane");
});
