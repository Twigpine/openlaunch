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
const feed = read("./RiverFeed.tsx");
const rail = read("./JustLaunched.tsx");
const list = read("./LaunchList.tsx");
const home = read("../../app/(home)/page.tsx");
const chainLanding = read("./ChainLanding.tsx");
const beam = read("../vendor/border-beam.tsx");

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
  // the list carries the same events as the default bubble map: the window it chose, as links
  assert.match(river, /<TapeList items=\{inView\.map\(\(e\) => e\.item\)\}/);
});

test("reduced motion holds the river still and drops the arrival ping", () => {
  const still = riverCss.slice(riverCss.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(still, /\.mark \{ animation: none; transform: translateX\(calc\(var\(--age\) \* -100cqw\)\); opacity: var\(--fade\); \}/);
  assert.match(still, /\.ping \.dot, \.ping \.avatar \{ animation: none; \}/);
});

test("the latest column is real links in a fixed-height list, so an arrival never resizes the section", () => {
  // the column reads the day-long history in both drawings, so a quiet half hour never empties it
  assert.equal((river.match(/<RiverFeed entries=\{recent\} now=\{now\} \/>/g) ?? []).length, 2);
  assert.match(feed, /<AnimatedList aria-label="Latest trades and launches" className="[^"]*\bh-\[7\.25rem\][^"]*\boverflow-hidden\b[^"]*\blg:h-\[15rem\]/);
  assert.match(feed, /prefetch=\{false\}/);
});

test("the hover card is part of the drawing: hidden from assistive tech and only opened by a mouse", () => {
  assert.match(river, /if \(e\.pointerType === "mouse"\) onEnter\(m, e\.currentTarget\)/);
  assert.match(river, /<div aria-hidden="true" className="pointer-events-none absolute z-20"/);
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

test("cards keep the star outside the card link, and the layout comes from the visitor's cookie on the server", () => {
  assert.match(list, /<LaunchCard [^\n]*\/>\n\s*\{\/\* outside the card's link: saving never navigates \*\/\}\n\s*<div [^>]*><WatchButton overlay token=/);
  assert.match(home, /const layout = parseLayout\(\(await cookies\(\)\)\.get\(LAYOUT_COOKIE\)\?\.value\);/);
  assert.match(home, /initialLayout=\{layout\}/);
  assert.match(list, /document\.cookie = layoutCookie\(next\);/);
});

test("the market list starts its clock at the server's render time, so hydration sees the same tiers and filters", () => {
  assert.match(list, /const \[now, setNow\] = useState\(serverNow\);/);
  assert.doesNotMatch(list, /useState\(\(\) => Date\.now\(\)\)/, "a render-time Date.now() differs between the server and the browser");
  for (const [page, src] of [["home", home], ["chain landing", chainLanding]] as const) {
    assert.match(src, /const now = nowMs\(\);/, page);
    assert.match(src, /<LaunchList [^\n]*serverNow=\{now\}/, page);
  }
});

test("the border beam renders the same markup on the server and the browser; reduced motion only hides it", () => {
  // the server cannot know the visitor's motion setting, so returning nothing for it breaks hydration (React #418)
  assert.doesNotMatch(beam, /if \(reduced\) return null/);
  assert.match(beam, /motion-reduce:hidden/);
  assert.match(beam, /animate=\{reduced \? undefined : /);
});

test("the watchlist star sits outside the row link, and the tab survives a back navigation", () => {
  assert.match(list, /<LaunchRow [^\n]*\/>\n\s*\{\/\* outside the row's link: saving never navigates \*\/\}\n\s*<div [^>]*><WatchButton token=/);
  assert.match(list, /if \(v === "watchlist"\) p\.set\("view", "watchlist"\);/);
  assert.match(home, /initialView=\{sp\.view === "watchlist" \? "watchlist" : "market"\}/);
  assert.match(list, /setListParams\(view === "market" \? \{ \.\.\.selection, limit \} : null\)/, "the shared poll skips the market list while the watchlist is open");
  assert.match(list, /request\.delete\("view"\);/, "the list API never receives the view");
});

test("the bubble map lays out once per update with no animation timer, and stays decorative like the river", () => {
  const bubbles = read("./LiveBubbles.tsx");
  const bubblesCss = read("./LiveBubbles.module.css");
  // d3-force is stopped at once and ticked by hand: no frame loop, no fetch; CSS does every move
  assert.match(bubbles, /forceSimulation\(nodes\)[\s\S]*?\.stop\(\);/);
  assert.match(bubbles, /sim\.tick\(\);/);
  assert.doesNotMatch(bubbles, /\bfetch\s*\(|requestAnimationFrame|\.restart\(\)|alphaTarget/);
  assert.match(bubblesCss, /transition: translate 1\.2s/);
  // decorative for assistive tech; the list view carries the same events as links
  assert.match(bubbles, /<div ref=\{field\} aria-hidden="true" className=\{styles\.field\}>/);
  assert.match(bubbles, /prefetch=\{false\}/);
  assert.match(bubbles, /tabIndex=\{-1\}/);
  // reduced motion: no float, no glide, no pulse, no sparks
  const still = bubblesCss.slice(bubblesCss.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(still, /\.bubble \{ transition: none; \}/);
  assert.match(still, /\.orb, \.born \{ animation: none; \}/);
  assert.match(still, /\.pulse, \.spark \{ display: none; \}/);
  // the bubble map is the default view, and the page hands it the whole seed so a quiet half hour is never blank
  assert.match(river, /useState<"bubbles" \| "river" \| "list">\("bubbles"\)/);
  assert.match(read("../../app/(home)/page.tsx"), /recent=\{feed\}/);
});
