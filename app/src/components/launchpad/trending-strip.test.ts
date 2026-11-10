import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createTranslator } from "use-intl/core";
import { chipText } from "../../lib/launchpad/trending-live.ts";
import { riverUsd } from "../../lib/launchpad/river.ts";
import { messagesFor } from "../../i18n/messages/index.ts";

/**
 * Source contracts for what an independent review of the home page found: each is a rule the Trending board, the feed or the
 * hero coin must keep, pinned where the pure helpers cannot reach (the component itself, the page, the query).
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const strip = read("./TrendingStrip.tsx");
const home = read("../../app/(home)/page.tsx");
const queries = read("../../lib/launchpad/queries.ts");
const hero = read("./LaunchHero.tsx");
const store = read("../../lib/launchpad/imageStore.ts");

test("a change of window is a new list, not a race: no rank moves and no hand-over across it", () => {
  const advance = strip.slice(strip.indexOf("function advance("), strip.indexOf("/**\n * The reaction a card plays."));
  assert.match(advance, /if \(next\.window !== board\.snap\.window\) return \{ snap: next, crown, moves: \{\}, from: null \};/);
  assert.ok(advance.indexOf("next.window !== board.snap.window") < advance.indexOf("rankMoves("), "decided before any move is computed");
});

test("a reaction's chip reads exactly as chipText in English, and in the reader's language otherwise", () => {
  // the board's own chipWords and worded, run with use-intl's translator over each language's messages
  const ast = ts.createSourceFile("TrendingStrip.tsx", strip, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const pick = (name: string) => ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(ast) ?? assert.fail(`missing ${name}`);
  const { outputText } = ts.transpileModule(`${pick("chipWords")}\n${pick("worded")}\n({ chipWords, worded });`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  type Flow = { n: number; usd: number | null };
  type Hit = { token: string; buys: Flow; sells: Flow; dev: boolean };
  type Translate = ReturnType<typeof createTranslator>;
  const { chipWords, worded } = runInNewContext(outputText, { riverUsd }) as {
    chipWords: (t: Translate, hit: Omit<Hit, "token">) => string;
    worded: (cards: { fx: Record<string, { chip: string }> }, hits: Hit[], t: Translate) => { fx: Record<string, { chip: string }> };
  };
  const words = (locale: "en" | "zh-CN") => createTranslator({ locale, messages: messagesFor(locale), namespace: "market.trending" }) as unknown as Translate;
  for (const hit of [
    { buys: { n: 1, usd: 45 }, sells: { n: 0, usd: null }, dev: false },
    { buys: { n: 0, usd: null }, sells: { n: 1, usd: 303.65 }, dev: false },
    { buys: { n: 3, usd: 210 }, sells: { n: 0, usd: null }, dev: false },
    { buys: { n: 2, usd: 50 }, sells: { n: 1, usd: 20 }, dev: false },
    { buys: { n: 1, usd: null }, sells: { n: 0, usd: null }, dev: false },
    { buys: { n: 0, usd: null }, sells: { n: 2, usd: 8_400 }, dev: true },
  ]) assert.equal(chipWords(words("en"), hit), chipText(hit));
  assert.equal(chipWords(words("zh-CN"), { buys: { n: 2, usd: 50 }, sells: { n: 1, usd: 20 }, dev: true }), "2 笔买入 $50 · 卖出 $20 · 创建者");
  // only this poll's reactions are reworded; an earlier one keeps the words it was drawn with
  const cards = { tape: {}, flips: {}, fx: { a: { chip: "Buy $45", side: "buy" }, b: { chip: "卖出 $20", side: "sell" } } };
  const next = worded(cards, [{ token: "a", buys: { n: 1, usd: 45 }, sells: { n: 0, usd: null }, dev: false }], words("zh-CN"));
  assert.equal(next.fx.a.chip, "买入 $45");
  assert.equal((next.fx.a as { side?: string }).side, "buy", "the rest of the reaction is kept");
  assert.equal(next.fx.b, cards.fx.b);
  assert.equal(worded(cards, [], words("zh-CN")), cards, "a poll without reactions changes nothing");
});

test("a card that mounts with a reaction already on its token does not play it again", () => {
  assert.match(strip, /function useFreshFx\(fx: CardFx \| undefined\): CardFx \| undefined \{/);
  assert.match(strip, /const \[atMount\] = useState\(fx\?\.id\);\n\s*return fx && fx\.id !== atMount \? fx : undefined;/);
  assert.equal((strip.match(/const fx = useFreshFx\(onToken\);/g) ?? []).length, 2, "the big leader and the runner (which is also the phone's leader)");
  // the tape's trades that were still arriving when it mounted do not pop in again either
  assert.match(strip, /const \[before\] = useState\(\(\) => new Set\(pips\.filter\(arriving\)\.map\(\(p\) => p\.key\)\)\);/);
  assert.match(strip, /const fresh = arriving\(p\) && !before\.has\(p\.key\);/);
});

test("keyboard focus brings a partly visible card fully into the swipe row, and a tap does not scroll", () => {
  assert.match(strip, /e\.target\.closest\("li"\)\?\.scrollIntoView\(\{ inline: "nearest", block: "nearest" \}\);/);
  assert.ok(strip.indexOf('matches(":focus-visible")) return;') > -1 && strip.indexOf('matches(":focus-visible")) return;') < strip.indexOf("scrollIntoView"));
});

test("the first poll does not announce trades the page's feed already held", () => {
  assert.match(strip, /seenKeys = \[\] \}: \{ initial: Snap; serverNow: number; seenKeys\?: readonly string\[\] \}/);
  assert.match(strip, /\.\.\.seenKeys\]\);/);
  assert.match(home, /<TrendingStrip initial=\{trending\} serverNow=\{now\} seenKeys=\{feed\.filter\(\(item\) => item\.kind === "swap"\)\.map\(feedKey\)\} \/>/);
});

test("the home page survives a failed tape read, and the feed marks launches that wear a copied picture", () => {
  assert.match(queries, /const tape = await tapeOrNone\(\(\) => memo\(key, 3_000, \(\) => getBoardTapes\(shown\)\)/);
  assert.match(queries, /return tape \? \{ \.\.\.snap, tape \} : snap;/);
  assert.match(queries, /const reused = await pictureCopies\(db, launches\);/);
  assert.match(queries, /image_reused: true as const/);
  // the ownership read is a scan of bb_launch_meta that every home render would repeat: it is cached per set of pictures (a failure is not cached: memo clears it)
  assert.match(queries, /const all = await memo\(`picture-owners:\$\{sorted\.join\(","\)\}`, 30_000, \(\) => db<PictureUse\[\]>/);
  // a failed ownership read must not take the feed down, and must not let a picture through unchecked: every stored picture counts as a copy
  assert.match(queries.slice(queries.indexOf("async function pictureCopies")), /catch \(error\) \{\n\s*console\.warn\("\[feed\] picture ownership read failed:"[^\n]*\n\s*return new Set\(launches\.filter\(\(r\) => pictureKey\(r\.image_url\) !== null\)/);
});

test("the hero coin's picture can be switched off without a deploy", () => {
  assert.match(store, /return process\.env\.HERO_COIN_PICTURES\?\.trim\(\)\.toLowerCase\(\) !== "off";/);
  assert.match(hero, /<HeroLocker imageBase=\{coinPicturesEnabled\(\) \? imagePublicBase\(\) : null\} \/>/);
});
