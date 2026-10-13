import { test } from "node:test";
import assert from "node:assert/strict";
import { PALETTE_PAGES, buildPaletteGroups, isSearchableQuery, isTypingTarget, matchesQuery, paletteTokenFrom, type PaletteToken } from "./command-palette.ts";

const waifu: PaletteToken = { chain: "base", token: "0xf3018d16d3c75f86df76bdeed12027c813f4e4a0", name: "WAIFU", symbol: "WAIFU", image: null, capUsd: 53471, change: 18.7, holders: 196 };
const dottie: PaletteToken = { chain: "robinhood", token: "0x5b3c2cd87083ea5c4436525dca6213740405b69e", name: "DottieLand", symbol: "DOTTIE", image: null, capUsd: 53205, change: 9.54, holders: 285 };

test("before anything is typed: trending tokens, every page, both actions", () => {
  const groups = buildPaletteGroups({ query: "", tokens: [], trending: [waifu, dottie], theme: "dark" });
  assert.deepEqual(groups.map((g) => g.value), ["Trending now", "Pages", "Actions"]);
  assert.deepEqual(groups[0].items.map((i) => i.label), ["WAIFU", "DottieLand"]);
  assert.equal(groups[1].items.length, PALETTE_PAGES.length);
  assert.deepEqual(groups[2].items.map((i) => i.label), ["Bridge funds between chains", "Switch to the light theme"]);
});

test("a query narrows pages and actions and shows search hits under Tokens", () => {
  const groups = buildPaletteGroups({ query: "launch", tokens: [waifu], trending: [dottie], theme: "light" });
  assert.equal(groups[0].value, "Tokens");
  assert.deepEqual(groups[0].items.map((i) => i.label), ["WAIFU"]);
  const pages = groups.find((g) => g.value === "Pages")?.items.map((i) => i.label) ?? [];
  assert.ok(pages.includes("Launch a token"));
  assert.ok(!pages.includes("Posts"));
  assert.equal(groups.find((g) => g.value === "Actions"), undefined, "no action mentions launch");
});

test("one character never searches tokens and never shows trending as if it matched", () => {
  const groups = buildPaletteGroups({ query: "w", tokens: [waifu], trending: [dottie], theme: "dark" });
  assert.equal(groups.find((g) => g.value === "Tokens" || g.value === "Trending now"), undefined);
  assert.equal(isSearchableQuery("w"), false);
  assert.equal(isSearchableQuery(" wa "), true);
});

test("the theme action always offers the other theme, and keywords find it", () => {
  const dark = buildPaletteGroups({ query: "theme", tokens: [], trending: [], theme: "dark" });
  assert.deepEqual(dark.map((g) => g.items.map((i) => i.label)), [["Switch to the light theme"]]);
  const light = buildPaletteGroups({ query: "dark mode", tokens: [], trending: [], theme: "light" });
  assert.deepEqual(light.map((g) => g.items.map((i) => i.label)), [["Switch to the dark theme"]]);
});

test("every query word must appear, in any order, case-insensitively", () => {
  assert.equal(matchesQuery("chain robinhood", "Launches on Robinhood Chain"), true);
  assert.equal(matchesQuery("ROBIN", "launches on robinhood chain"), true);
  assert.equal(matchesQuery("robinhood base", "Launches on Robinhood Chain"), false);
  assert.equal(matchesQuery("   ", "anything"), true);
});

test("launch rows map to search tokens without inventing a price", () => {
  const t = paletteTokenFrom({ chain: "arc", token: "0x648A5382BDCF286E7FF5122D01A983DB314E620A", name: "Pacharan", symbol: "PANCHU", image_url: "https://openlaunch.lol/api/launch/image/t/x.webp", fdv_usd: 21381, change_from_launch: 3.2, holders: 1480 });
  assert.deepEqual(t, { chain: "arc", token: "0x648a5382bdcf286e7ff5122d01a983db314e620a", name: "Pacharan", symbol: "PANCHU", image: "https://openlaunch.lol/api/launch/image/t/x.webp", capUsd: 21381, change: 3.2, holders: 1480 });
  const unpriced = paletteTokenFrom({ chain: "base", token: "0xabc", name: "X", symbol: "X", fdv_usd: null, change_from_launch: Number.NaN });
  assert.equal(unpriced.capUsd, null);
  assert.equal(unpriced.change, 0);
  assert.equal(unpriced.image, null);
  assert.equal(unpriced.holders, 0);
});

test("item ids are unique across groups, so the list can key on them", () => {
  const groups = buildPaletteGroups({ query: "", tokens: [], trending: [waifu, dottie], theme: "dark" });
  const ids = groups.flatMap((g) => g.items.map((i) => i.id));
  assert.equal(new Set(ids).size, ids.length);
});

test("the slash shortcut types a slash inside fields and opens search everywhere else", () => {
  assert.equal(isTypingTarget({ tagName: "input" }), true);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ tagName: "SELECT" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "BODY" }), false);
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget(null), false);
});
