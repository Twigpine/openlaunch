import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeedItem } from "./queries";
import { feedKey } from "./river.ts";
import { COIN_LIFE_MS, FRESH_LAUNCH_MS, brandLookalike, coinActive, ownImage, pickLaunch } from "./hero-coin.ts";

const NOW = 1_800_000_000_000;
const BASE = "https://openlaunch.lol/api/launch/image";
const HEX = "ab".repeat(24);
const OWN = `${BASE}/t/${HEX}.webp`;

let n = 0;
const launch = (o: { name?: string; symbol?: string; image?: string | null; ageMs?: number; chain?: string } = {}): FeedItem => ({
  kind: "launch", chain: (o.chain ?? "base") as "base", at: new Date(NOW - (o.ageMs ?? 5_000)).toISOString(), tx_hash: `0x${(++n).toString(16).padStart(64, "0")}`,
  token: "0x" + n.toString(16).padStart(40, "0"), name: o.name ?? "Moon Cat", symbol: o.symbol ?? "MCAT", launcher: "0x1", lp_fee: 10_000, quote_key: "eth", image_url: o.image === undefined ? OWN : o.image,
} as FeedItem);
const swap = (): FeedItem => ({ kind: "swap", chain: "base", at: new Date(NOW).toISOString(), tx_hash: "0xaa", log_index: 1, token: "0xbb", name: "T", symbol: "T", trader: "0x1", is_buy: true, is_dev: false, quote_wei: "1", quote_key: "eth", quote_symbol: "ETH", quote_decimals: 18, usd: 5, image_url: null } as FeedItem);

test("only our own stored images are drawn: our host, our key shape, nothing after the key", () => {
  assert.equal(ownImage(OWN, BASE), OWN);
  assert.equal(ownImage(OWN, `${BASE}/`), OWN, "a trailing slash on the base is fine");
  for (const bad of [
    `https://evil.example/api/launch/image/t/${HEX}.webp`,
    `${BASE}/t/${HEX}.webp?x=1`, `${BASE}/t/${HEX}.webp#x`, `${BASE}/t/${HEX}.png`, `${BASE}/t/${HEX.slice(2)}.webp`, `${BASE}/t/${HEX}00.webp`,
    `${BASE}/../t/${HEX}.webp`, `${BASE}/t/../${HEX}.webp`, `${BASE}x/t/${HEX}.webp`, `https://avatars.githubusercontent.com/u/1`, `data:image/svg+xml,<svg/>`, "",
  ]) assert.equal(ownImage(bad, BASE), null, bad);
  assert.equal(ownImage(OWN, null), null, "no image store, no picture");
  assert.equal(ownImage(null, BASE), null);
});

test("a name or symbol that imitates a brand loses its picture, including the usual look-alike spellings", () => {
  for (const [name, symbol] of [["OpenLaunch", "OL"], ["0penLaunch", "X"], ["Open Launch Official", "OLO"], ["x", "OL"], ["Twig Szn", "SZN"], ["TW1G", "T"], ["Coinbase Pro", "CBP"], ["Gitlawb Rewards", "GLR"], ["Uniswap v5", "UNI5"], ["Robinhood Stock", "HOOD"], ["USDC", "USDC"], ["Base", "B"], ["x", "ETH"], ["Official Token", "OFF"]]) {
    assert.equal(brandLookalike(name, symbol), true, `${name} / ${symbol}`);
  }
  for (const [name, symbol] of [["Moon Cat", "MCAT"], ["Basecamp", "BASECAMP"], ["Data Base Dog", "DBD"], ["Olive", "OLV"], ["Archer", "ARCH"], ["Pine", "PINE"], ["Waifu", "WAIFU"]]) {
    assert.equal(brandLookalike(name, symbol), false, `${name} / ${symbol}`);
  }
});

test("a new, young launch reacts once: the newest of a poll, with its picture when it is allowed one", () => {
  const first = launch({ name: "First" }), newest = launch({ name: "Newest" });
  const p = pickLaunch([newest, swap(), first], new Set(), NOW, BASE);
  assert.equal(p.reaction?.key, feedKey(newest), "the newest launch of the poll");
  assert.deepEqual([p.reaction?.src, p.reaction?.chain, p.reaction?.since], [OWN, "base", NOW]);
  assert.ok(p.seen.has(feedKey(first)) && p.seen.has(feedKey(newest)), "both are remembered");
  const again = pickLaunch([newest, first], p.seen, NOW + 5_000, BASE);
  assert.equal(again.reaction, null, "a re-sent poll does not react again");
});

test("the page's own launches never react, and neither does an old one a waking tab sees", () => {
  const onPage = launch(), old = launch({ ageMs: FRESH_LAUNCH_MS + 1_000 });
  assert.equal(pickLaunch([onPage], new Set([feedKey(onPage)]), NOW, BASE).reaction, null);
  const p = pickLaunch([old], new Set(), NOW, BASE);
  assert.equal(p.reaction, null);
  assert.ok(p.seen.has(feedKey(old)), "but it is remembered, so it cannot react later");
});

test("a launch with no usable picture still reacts, with a caption and no picture", () => {
  assert.equal(pickLaunch([launch({ image: null })], new Set(), NOW, BASE).reaction?.src, null);
  assert.equal(pickLaunch([launch({ image: "https://evil.example/a.webp" })], new Set(), NOW, BASE).reaction?.src, null);
  assert.equal(pickLaunch([launch({ name: "OpenLaunch Official" })], new Set(), NOW, BASE).reaction?.src, null, "a look-alike");
  assert.equal(pickLaunch([launch()], new Set(), NOW, null).reaction?.src, null, "uploads off");
  assert.ok(pickLaunch([launch({ name: "OpenLaunch Official" })], new Set(), NOW, BASE).reaction, "the launch itself is still news");
});

test("only launches count, memory is bounded, and the coin lasts COIN_LIFE_MS on the poll's clock", () => {
  assert.equal(pickLaunch([swap()], new Set(), NOW, BASE).reaction, null);
  const many = Array.from({ length: 150 }, () => launch({ ageMs: FRESH_LAUNCH_MS + 5_000 }));
  assert.ok(pickLaunch(many, new Set(), NOW, BASE).seen.size <= 100);
  const r = pickLaunch([launch()], new Set(), NOW, BASE).reaction;
  assert.equal(coinActive(r, NOW), true);
  assert.equal(coinActive(r, NOW + COIN_LIFE_MS - 1), true);
  assert.equal(coinActive(r, NOW + COIN_LIFE_MS), false);
  assert.equal(coinActive(null, NOW), false);
});

test("disguised spellings of a brand are caught: fullwidth, styled and accented letters, a capital I for an l, separators, vv for w", () => {
  for (const name of ["ｏｐｅｎｌａｕｎｃｈ", "𝗼𝗽𝗲𝗻𝗹𝗮𝘂𝗻𝗰𝗵", "ⓖⓘⓣⓛⓐⓦⓑ", "Gítláwb", "GitIawb", "G1tlawb", "g.i.t.l.a.w.b", "g i t l a w b", "Twig​pine", "Gitlavvb", "Rob!nhood", "C0inbase", "Uni$wap"]) {
    assert.equal(brandLookalike(name, "X"), true, name);
  }
});

test("letters borrowed from another script cannot be checked, so the picture is dropped: Cyrillic, Greek, IPA and small capitals", () => {
  for (const name of ["оpenlaunch", "gіtlawb", "Twіg", "Gitlawb", "Οfficial", "ɡitlawb", "ᴏpenlaunch", "Моon Cat", "Привет", "Ελλάδα"]) {
    assert.equal(brandLookalike(name, "X"), true, name);
  }
  assert.equal(brandLookalike("Moon Cat", "ΜCAT"), true, "the symbol too");
});

test("honest names keep their picture, whatever the script that cannot spell a Latin word", () => {
  for (const [name, symbol] of [["Moon Cat", "MCAT"], ["Olive", "OLV"], ["Basecamp", "BCAMP"], ["Pine", "PINE"], ["狗狗币", "GGB"], ["Doge 狗狗", "DOGE"], ["猫", "CAT"], ["고양이", "GOYANGI"], ["แมว", "MEOW"], ["قطة", "QITTA"], ["Café Noir", "CAFE"], ["Señor Gato", "SG"], ["Pepe 🐸", "PEPE"], ["🚀🚀🚀", "MOON"]]) {
    assert.equal(brandLookalike(name, symbol), false, `${name} / ${symbol}`);
  }
});

test("a picture another token registered first never reaches the coin, but the launch still reacts with its caption", () => {
  const copy = { ...launch({ name: "Moon Cat" }), image_reused: true } as FeedItem;
  const p = pickLaunch([copy], new Set(), NOW, BASE);
  assert.equal(p.reaction?.src, null, "the picture belongs to the earlier token");
  assert.equal(p.reaction?.chain, "base", "the launch is still news");
  assert.equal(pickLaunch([launch({ name: "Moon Cat" })], new Set(), NOW, BASE).reaction?.src, OWN, "its own picture is drawn");
});
