import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSearchHit, compareSearchHitByHolders, escapeLike, isAddressQuery, matchesFilter, matchesQuery, normalizeQuery, rankHit, type RankedHit } from "./search.ts";

const row = (o: Partial<Parameters<typeof matchesQuery>[0]> = {}) => ({
  name: "Clear Sky",
  symbol: "SKY",
  token: "0x203e7cdcb0eb71087aeef09c4572efd4293008dc",
  lp_fee: 0,
  quote_symbol: "ETH",
  block_time: new Date(Date.now() - 3600_000).toISOString(),
  recipients: [{ payout: "0x000000000000000000000000000000000000dead", bps: 10000 }],
  ...o,
});

test("normalizeQuery strips $ and case", () => {
  assert.equal(normalizeQuery("  $SKY "), "sky");
  assert.equal(normalizeQuery("Clear   Sky"), "clear sky");
});

test("address queries match only the exact token", () => {
  assert.equal(isAddressQuery("0x203E7CDCB0EB71087AEEF09C4572EFD4293008DC"), true);
  assert.equal(matchesQuery(row(), "0x203E7CDCB0EB71087AEEF09C4572EFD4293008DC"), true);
  assert.equal(matchesQuery(row(), "0x0000000000000000000000000000000000000001"), false);
});

test("text queries match name or symbol substrings; empty matches all", () => {
  assert.equal(matchesQuery(row(), "sky"), true);
  assert.equal(matchesQuery(row(), "$sk"), true);
  assert.equal(matchesQuery(row(), "clear"), true);
  assert.equal(matchesQuery(row(), "dog"), false);
  assert.equal(matchesQuery(row(), ""), true);
});

test("filters: fee0 / burn / usdg / today", () => {
  assert.equal(matchesFilter(row(), "fee0"), true);
  assert.equal(matchesFilter(row({ lp_fee: 10_000 }), "fee0"), false);
  assert.equal(matchesFilter(row({ lp_fee: 10_000 }), "burn"), true, "1% + dead recipient = burn");
  assert.equal(matchesFilter(row({ lp_fee: 10_000, recipients: [{ payout: "0xabc", bps: 10000 }] }), "burn"), false);
  assert.equal(matchesFilter(row(), "burn"), false, "0% pools are not 'burn'");
  assert.equal(matchesFilter(row({ quote_key: "usdg" }), "usdg"), true);
  assert.equal(matchesFilter(row({ quote_key: "gitlawb" }), "gitlawb"), true);
  assert.equal(matchesFilter(row({ quote_key: "eth" }), "gitlawb"), false);
  assert.equal(matchesFilter(row(), "today"), true);
  assert.equal(matchesFilter(row({ block_time: new Date(Date.now() - 3 * 86_400_000).toISOString() }), "today"), false);
  assert.equal(matchesFilter(row(), null), true);
});

test("rankHit orders symbol exact < symbol prefix < name prefix < substring", () => {
  assert.equal(rankHit(row(), "sky"), 0);
  assert.equal(rankHit(row(), "sk"), 1);
  assert.equal(rankHit(row(), "clear"), 2);
  assert.equal(rankHit(row(), "ear"), 3);
});

test("escapeLike neutralizes LIKE wildcards and the escape char", () => {
  assert.equal(escapeLike("abc"), "abc");
  assert.equal(escapeLike("a%b"), "a\\%b");
  assert.equal(escapeLike("a_b"), "a\\_b");
  assert.equal(escapeLike("a\\b"), "a\\\\b");
  assert.equal(escapeLike("%_%"), "\\%\\_\\%");
});

const hit = (o: Partial<RankedHit> = {}): RankedHit => ({
  ...row(),
  chain_id: 8453,
  block_number: 30_000_000,
  ...o,
});

test("compareSearchHit: relevance first, then cross-chain newest-first", () => {
  const exactLowChain = hit({ symbol: "FOO", chain_id: 7777777, block_number: 5_000, block_time: "2026-09-11T23:59:00.000Z" });
  const substringHighChain = hit({ symbol: "XFOOX", name: "Xfoox thing", chain_id: 8453, block_number: 30_000_000, block_time: "2026-09-12T00:00:00.000Z" });
  assert.ok(compareSearchHit(exactLowChain, substringHighChain, "foo") < 0, "exact match on a low-height chain beats a newer substring match");
  assert.ok(compareSearchHit(substringHighChain, exactLowChain, "foo") > 0);
});

test("compareSearchHit: same rank orders by block time, not raw block number", () => {
  const olderHighHeight = hit({ symbol: "FOOA", chain_id: 8453, block_number: 30_000_000, block_time: "2026-09-11T00:00:00.000Z" });
  const newerLowHeight = hit({ symbol: "FOOB", chain_id: 7777777, block_number: 5_000, block_time: "2026-09-12T00:00:00.000Z" });
  assert.ok(compareSearchHit(newerLowHeight, olderHighHeight, "foo") < 0, "newer launch wins despite a far lower block number");
  const sorted = [olderHighHeight, newerLowHeight].sort((a, b) => compareSearchHit(a, b, "foo"));
  assert.deepEqual(sorted.map((r) => r.symbol), ["FOOB", "FOOA"]);
});

test("compareSearchHit: rank dominates time; ties break deterministically", () => {
  const newerSubstring = hit({ symbol: "XFOOX", name: "Xfoox", block_time: "2026-09-12T00:00:00.000Z", block_number: 30_000_001 });
  const olderPrefix = hit({ symbol: "FOOX", block_time: "2026-09-11T00:00:00.000Z", block_number: 30_000_000 });
  assert.ok(compareSearchHit(olderPrefix, newerSubstring, "foo") < 0, "prefix beats newer substring");
  const a = hit({ symbol: "FOO", block_time: "2026-09-12T00:00:00.000Z", chain_id: 8453, block_number: 7 });
  const b = hit({ symbol: "FOO", block_time: "2026-09-12T00:00:00.000Z", chain_id: 8453, block_number: 7 });
  assert.equal(compareSearchHit(a, b, "foo"), 0);
});

test("compareSearchHitByHolders: relevance first, then the token more wallets hold, then newest-first", () => {
  const popularOld = { ...hit({ symbol: "WAIFU", name: "WAIFU", block_time: "2026-09-06T10:56:57.000Z" }), holders: 196 };
  const copyNew = { ...hit({ symbol: "WAIFU", name: "wifu", block_time: "2026-10-04T16:00:00.000Z" }), holders: 0 };
  const prefixBusy = { ...hit({ symbol: "WAIFUX", name: "Waifu X", block_time: "2026-10-01T00:00:00.000Z" }), holders: 5_000 };
  // newest-first (the list's search order) would put this week's copy on top
  assert.ok(compareSearchHit(copyNew, popularOld, "waifu") < 0);
  assert.ok(compareSearchHitByHolders(popularOld, copyNew, "waifu") < 0, "the held token outranks its new copy");
  assert.ok(compareSearchHitByHolders(copyNew, prefixBusy, "waifu") < 0, "relevance still comes before holders");
  const tieA = { ...hit({ symbol: "FOO", block_time: "2026-09-12T00:00:00.000Z" }), holders: 3 };
  const tieB = { ...hit({ symbol: "FOO", block_time: "2026-09-11T00:00:00.000Z" }), holders: 3 };
  assert.ok(compareSearchHitByHolders(tieA, tieB, "foo") < 0, "equal holders fall back to newest-first");
});
