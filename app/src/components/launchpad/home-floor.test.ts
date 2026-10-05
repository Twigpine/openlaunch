import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contracts for the home page's live floor: the river, the Just launched rail, the trending row and the
 * watchlist tab. The layout math is unit-tested in lib/launchpad/river.test.ts; browser QA covers the motion.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const river = read("./LiveRiver.tsx");
const riverCss = read("./LiveRiver.module.css");
const rail = read("./JustLaunched.tsx");
const list = read("./LaunchList.tsx");
const home = read("../../app/(home)/page.tsx");

test("the river draws from the shared poll and never fetches or animates from script", () => {
  assert.match(river, /useLive\(\)/);
  assert.match(river, /mergeRiver\(cur, feed, t\)/);
  assert.doesNotMatch(river, /\bfetch\s*\(|requestAnimationFrame/);
  // one CSS clock: a negative delay places each mark at its true age
  assert.match(riverCss, /animation: drift 1800s linear both;/);
  assert.match(river, /"--delay": `-\$\{m\.ageAtSeen\}ms`/);
});

test("river marks never prefetch a token page each, and the drawing has a list for assistive tech", () => {
  assert.match(river, /prefetch=\{false\}/, "a hundred marks must not mean a hundred prefetches");
  assert.match(river, /tabIndex=\{-1\}/);
  assert.match(river, /ref=\{field\} aria-hidden="true"/);
  assert.match(river, /aria-label="Show as a list"/);
  assert.match(river, /<TapeList items=\{entries\.map\(\(e\) => e\.item\)\}/);
});

test("reduced motion holds the river still and drops the arrival ping", () => {
  const still = riverCss.slice(riverCss.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(still, /\.mark \{ animation: none; transform: translateX\(calc\(var\(--age\) \* -100cqw\)\); opacity: var\(--fade\); \}/);
  assert.match(still, /\.ping \.dot, \.ping \.avatar \{ animation: none; \}/);
});

test("a cut-off seed never claims a 30-minute total", () => {
  assert.match(home, /coveredSince=\{riverCoverage\(feed, RIVER_SEED, now\)\}/);
  assert.match(river, /riverSummary\(entries, complete\)/);
});

test("the Just launched rail re-reads the market model only when an event says it changed", () => {
  assert.match(rail, /subscribe\(\(snap\) =>/);
  assert.match(rail, /\/api\/launch\/list\?sort=new&limit=\$\{JUST_LAUNCHED_SIZE\}/);
  assert.match(rail, /const MIN_GAP_MS = 10_000;/);
  assert.doesNotMatch(rail, /setInterval\(\s*\(\)\s*=>\s*(?:void\s+)?load/, "no polling of its own");
  assert.match(rail, /trades \? .*"No trades yet"/s);
});

test("the watchlist star sits outside the row link, and the tab survives a back navigation", () => {
  assert.match(list, /<LaunchRow [^\n]*\/>\n\s*\{\/\* outside the row's link: saving never navigates \*\/\}\n\s*<div [^>]*><WatchButton token=/);
  assert.match(list, /if \(v === "watchlist"\) p\.set\("view", "watchlist"\);/);
  assert.match(home, /initialView=\{sp\.view === "watchlist" \? "watchlist" : "market"\}/);
  assert.match(list, /setListParams\(view === "market" \? \{ \.\.\.selection, limit \} : null\)/, "the shared poll skips the market list while the watchlist is open");
  assert.match(list, /request\.delete\("view"\);/, "the list API never receives the view");
});
