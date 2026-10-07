import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contracts for the home page's live floor: the Trending board, the river, the Just launched rail and the
 * watchlist tab. The layout math is unit-tested in lib/launchpad/river.test.ts and trending-board.test.ts; browser QA
 * covers the motion.
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
const board = read("./TrendingStrip.tsx");

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
  // phones show one card (the hero's live line carries the newest event), tablets a row of two, the desktop column four
  assert.match(feed, /<AnimatedList aria-label="Latest trades and launches" className="[^"]*\bh-\[3\.375rem\][^"]*\boverflow-hidden\b[^"]*\blg:h-\\?\[15rem\]/);
  assert.match(feed, /max-sm:\[&>li:nth-child\(n\+2\)\]:hidden max-lg:\[&>li:nth-child\(n\+3\)\]:hidden/);
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

test("the page runs hero, Trending, river, list, and the hero's link has a place to land", () => {
  const at = ["<LaunchHero ", "<TrendingStrip ", "<LiveRiver ", "<LaunchList "].map((tag) => home.indexOf(tag));
  assert.ok(at.every((i) => i >= 0), "all four are on the page");
  assert.deepEqual(at, [...at].sort((a, b) => a - b), "in that order");
  assert.match(board, /<section id="trending" aria-labelledby="trending-heading" className="min-w-0 scroll-mt-24">/, "below the sticky header, not under it");
});

test("the top card is called Leading only on the hour window", () => {
  assert.match(board, /\{window === "1h" \? "Leading" : "Top · 24h"\}/, "a token with no trade this hour is not leading anything");
  assert.match(board, /<span className="sr-only">\{window === "1h" \? "Leading" : "Top over 24 hours"\}<\/span>/, "and the short mark has spoken words");
  assert.match(board, /\{snap\.window === "1h" \? "Last hour" : "Last 24 hours"\}/);
});

test("the board states its own rule with the ranking's numbers, where touch and keyboard reach it", () => {
  assert.match(board, /<summary [^>]*>How it&apos;s ranked</);
  assert.match(board, /next \{SNIPER_BLOCKS\} blocks are left out/);
  assert.match(board, /under \{FRESH_HOURS\} hours old/);
  assert.match(board, /needs \{MIN_TRADES_1H\} trades and \{MIN_TRADERS_1H\} such wallets in the last hour/);
  assert.match(board, /fewer than \{MIN_STRIP\} tokens do, the board shows the last 24 hours, where \{MIN_TRADES_1H\} trades and one such wallet/);
  assert.match(board, /const WINDOW_NOTE = "Wallets other than the launcher that traded in this window\. Trades and volume count every swap\.";/);
  assert.match(board, /Tokens paired with an unlisted asset are not ranked\./, "trendingFrom drops them before ranking");
  assert.match(board, /<div title=\{WINDOW_NOTE\}/);
  // read once for the board, after the list, not inside every card's link
  assert.match(board, /<ol\n\s*ref=\{list\}\n\s*aria-label="Trending tokens"\n\s*aria-describedby="trending-note"/);
  assert.match(board, /<\/ol>\n\s*\)\}\n[^\n]*\n\s*\{first \? <p id="trending-note" className="sr-only">\{WINDOW_NOTE\}<\/p> : null\}/);
  assert.equal((board.match(/\{WINDOW_NOTE\}/g) ?? []).length, 2, "the title on the figures and the one spoken note");
  // the header is all in flow (text spacing wraps it, nothing overlaps) and the panel spans the board under it
  assert.match(board, /<details className="group peer [^"]*">\n\s*<summary className="[^"]*\bh-11\b[^"]*\bsm:h-8\b[^"]*">How it&apos;s ranked/);
  assert.match(board, /<p className="[^"]*\bhidden basis-full\b[^"]*\bpeer-open:block">/);
  assert.doesNotMatch(board.slice(0, board.indexOf("<ol")), /\babsolute\b/);
});

test("a card's tooltip is a sentence, so it names the chain in full", () => {
  assert.match(board, /const hint = \(row: LaunchRow\) => `\$\{row\.name\} on \$\{CHAIN_LABELS\[row\.chain\]\}, paired with \$\{row\.quote_symbol\}`;/);
  assert.equal((board.match(/title=\{hint\(row\)\}/g) ?? []).length, 2);
});

test("the board carries no decoration, and the ranking's own figure shows on every width", () => {
  assert.doesNotMatch(board, /blur-/, "no glow behind the leader");
  assert.equal((board.match(/text=\{count\(a\.wallets\)\}/g) ?? []).length, 2, "wallets trading on the leader and on a runner");
  // a bare `hidden` class hides on phones; only the header caption, the open spot, the closed rule panel and the
  // leader's "Last trades" label (the tape beside it says it all) may use one
  const hidden = board.split("\n").filter((line) => /(?<![\w:-])hidden(?![\w-])/.test(line));
  assert.equal(hidden.length, 5, "+ the big leader card, which only exists from 1024px (the swipe row has the compact one)");
  assert.ok(hidden.some((line) => line.includes("<Leader ")));
  assert.ok(hidden.some((line) => line.includes("Last trades")));
  assert.ok(hidden.some((line) => line.includes("Ranked by wallets trading, trades and volume")));
  assert.ok(hidden.some((line) => line.includes("Open spot.")));
  assert.ok(hidden.some((line) => line.includes("peer-open:block")));
  assert.ok(!hidden.some((line) => line.includes("a.wallets")));
  assert.match(board, /const count = \(n: number\) => n\.toLocaleString\("en-US"\);/);
  assert.match(board, /text-\[30px\] font-bold leading-\[1\.2\] tracking-normal/, "no negative tracking on a bold figure");
});

test("the board re-sorts on the shared poll alone, and holds only under a mouse or a keyboard focus", () => {
  assert.match(board, /useEffect\(\(\) => subscribe\(\(live\) =>/);
  assert.doesNotMatch(board, /setInterval\(|\bfetch\s*\(/, "no clock or request of its own");
  // the one timer is the wait for a poll's reactions to land before the order changes; it is cleared when a poll replaces it and on unmount
  assert.equal((board.match(/setTimeout\(/g) ?? []).length, 1);
  assert.match(board, /window\.clearTimeout\(settle\.current\);\n\s*if \(settling && !held\) settle\.current = window\.setTimeout\(release, cascadeMs\(plan\.hits\)\);/);
  assert.match(board, /useEffect\(\(\) => \(\) => window\.clearTimeout\(settle\.current\), \[\]\);/);
  assert.match(board, /holdOnPoll\(hold\.current\)/);
  assert.match(board, /if \(e\.pointerType === "mouse"\) hold\.current = \{ \.\.\.hold\.current, pointer: true \};/);
  assert.match(board, /if \(e\.target\.matches\(":focus-visible"\)\)/, "a click focuses a card too and must not hold");
  assert.match(board, /refreshInPlace\(cur\.snap\.items, next\.items\)/, "held figures stay fresh");
  // a hold keeps the order only: a changed window or a token that left the ranking still moves the board on
  assert.match(board, /\(held \|\| settling\) && sameBoard\(cur\.snap, next\) \? \{ \.\.\.cur, snap: \{ \.\.\.cur\.snap, items: refreshInPlace\(cur\.snap\.items, next\.items\) \} \} : advance\(cur, next, live\.at\)/);
  assert.match(board, /setBoard\(\(cur\) => \(cur\.snap === next \? cur : advance\(cur, next, at\)\)\);/, "a release never counts one poll twice");
  assert.match(board, /const settling = !reduced && plan\.hits\.length > 0;/, "reduced motion has no reactions to wait for");
  assert.match(board, /stickyKing\(board\.crown\.king,/);
  assert.match(board, /layout=\{reduced \? false : "position"\}/);
  assert.match(board, /boardCells\(rest\.length\)/);
  assert.match(board, /key=\{launchKey\(row\)\}/, "chain-scoped identity");
});

test("every bar is on one scale, and the leader's hand-over is for a new leader only", () => {
  assert.match(board, /const top = barScale\(items\.map\(\(row\) => activity\(row, snap\.window\)\.wallets\)\);/);
  assert.equal((board.match(/barWidth\(a\.wallets, top\)/g) ?? []).length, 2, "the leader's bar and a runner's");
  assert.match(board, /moves: \{\}, from: null \}\);/, "not on page load");
  assert.match(board, /const handed = was\.length > 0 && shown\.length > 0 && launchKey\(shown\[0\]\) !== launchKey\(was\[0\]\);/);
  assert.match(board, /from: handed \? \{ name: was\[0\]\.name, since: at \} : board\.from/);
  assert.match(board, /const handover = from !== null && now - from\.since < HANDOVER_LIFE_MS;/, "it lasts a few seconds, measured on the poll's clock");
  assert.match(board, /from=\{board\.from\}/);
  assert.doesNotMatch(board, /bb-tape-enter|swapped/, "the old one-line entrance is gone");
});

test("a re-sort that unmounts the focused card hands focus back to a card, without scrolling", () => {
  assert.match(board, /focused\.current = focusedCard\(list\.current\);/);
  assert.match(board, /if \(!was \|\| document\.activeElement !== document\.body\) return;/, "only when focus actually fell to the page");
  assert.match(board, /\?\? cards\[0\]\)\?\.focus\(\{ preventScroll: true \}\);\n\s*\}, \[order\]\);/);
});

test("the leader's ages start from the server's clock and tick with the poll", () => {
  assert.match(home, /<TrendingStrip initial=\{trending\} serverNow=\{now\} \/>/);
  assert.match(board, /const \[now, setNow\] = useState\(serverNow\);/);
  assert.match(board, /setNow\(live\.at\);/);
  assert.match(board, /suppressHydrationWarning>\{facts\}/);
  // "last trade" is the latest swap by anyone, as the Trades figure beside it counts everyone
  assert.match(board, /const lastTrade = lastTradeAt\(row, pips\);/, "the later of the row's times and the newest trade on the tape");
  assert.match(board, /now - lastTrade < 10_000 \? "last trade just now" : `last trade \$\{ago\(new Date\(lastTrade\)\.toISOString\(\), now\)\} ago`/);
});

test("the Trending heading says what its window is", () => {
  assert.match(board, /\{snap\.window === "1h" \? "Trending this hour" : "Trending today"\}/);
});

test("the cards' tapes start from the page's seed, and the seed's trades are never announced again", () => {
  assert.match(home, /const trending = await withBoardTape\(fetchedTrending \?\? trendingFrom\(page\.items\)\);/);
  assert.match(board, /const seedTape = \(snap: Snap\): Record<string, TapePip\[\]> =>/);
  assert.match(board, /seen\.current = new Set\(Object\.values\(seedTape\(initial\)\)\.flatMap\(\(pips\) => pips\.map\(\(p\) => p\.key\)\)\);/);
  assert.match(board, /planHits\(\{ feed: live\.feed, seen: seen\.current \?\? new Set\(\), board: onBoard, at: live\.at \}\);/);
  assert.match(board, /setCards\(\(cur\) => applyPlan\(cur, plan, live\.at, onBoard\)\);/, "tokens that left the board are forgotten");
});

test("a reaction is decorative, keyed per reaction, and replays only when a new trade lands", () => {
  const nodes = board.slice(board.indexOf("function FxNodes"), board.indexOf("/** A card's last trades"));
  assert.equal((nodes.match(/aria-hidden="true"/g) ?? []).length, 2, "the edge and the figure are hidden from assistive tech");
  assert.match(nodes, /key=\{`e:\$\{fx\.id\}`\}/);
  assert.match(nodes, /key=\{`c:\$\{fx\.id\}`\}/);
  assert.match(board, /const fxClass = \(fx: CardFx \| undefined\) => \(fx \? \(fx\.parity === 0 \? styles\.hitA : styles\.hitB\) : ""\);/, "two identical keyframes, swapped per hit");
  // the leader's hand-over pieces are inert too
  assert.match(board, /<span aria-hidden="true" className=\{styles\.sweep\} \/><span aria-hidden="true" className=\{`\$\{styles\.edge\} \$\{styles\.edgeLead\}`\} \/>/);
  assert.match(board, /<span aria-hidden="true" title=\{move\.delta > 0/, "the rank-move chip is inert");
});

test("every effect ends invisible and reduced motion moves nothing", () => {
  const css = read("./TrendingStrip.module.css");
  // one keyframes block: from its name to the next line that starts something else
  const frames = (name: string) => new RegExp(`@keyframes ${name} \\{[\\s\\S]*?\\n(?=[@./])`).exec(css)?.[0] ?? "";
  assert.match(frames("edge"), /100% \{ opacity: 0; \}/);
  assert.match(frames("chipFloat"), /100% \{ opacity: 0;/);
  assert.match(frames("sweep"), /100% \{ transform: scaleX\(1\); opacity: 0; \}/);
  assert.match(css, /\.edge \{[^}]*opacity: 0;[^}]*animation: edge [^}]*backwards;/, "at rest, and before its turn");
  assert.match(css, /\.chip \{[^}]*opacity: 0;[^}]*animation: chipFloat [^}]*backwards;/);
  const still = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(still, /\.hitA, \.hitB, \.pipFresh > i, \.handover \.row, \.move, \.streak \{ animation: none; \}/, "nothing moves");
  assert.match(still, /\.chip \{ animation-name: chipFade; \}/, "the figure still shows, as a fade in place");
  assert.match(still, /\.sweep \{ display: none; \}/);
  assert.doesNotMatch(css.slice(css.indexOf("@keyframes chipFade"), css.indexOf("@media (prefers-reduced-motion: reduce)")), /transform|translate|scale/, "the fade has no movement");
});

test("the rank-move chip and the hand-over are measured on the poll's clock, and the order waits for a poll's reactions", () => {
  assert.match(board, /now - move\.since < MOVE_LIFE_MS/);
  assert.match(board, /for \(const \[token, m\] of Object\.entries\(board\.moves\)\) if \(at - m\.since < MOVE_LIFE_MS\) moves\[token\] = m;/);
  assert.match(board, /const settling = !reduced && plan\.hits\.length > 0;/);
  assert.match(board, /pending\.current = held \|\| settling \? next : null;/);
});

test("a figure that rolls keeps real text in the page, and its ghost is hidden and rests invisible", () => {
  const roll = read("./Roll.tsx");
  const css = read("./Roll.module.css");
  assert.match(roll, /<span key=\{`i\$\{shown\.n\}`\} className=\{rolled \? styles\.in : undefined\}>\{text\}<\/span>/, "the current text is plain text, animated only after a change");
  assert.match(roll, /<span key=\{`o\$\{shown\.n\}`\} aria-hidden="true" className=\{styles\.out\}>\{shown\.from\}<\/span>/);
  assert.match(css, /\.out \{[^}]*position: absolute;[^}]*animation: out [^}]*both;/, "out of the flow, and it stays at its end state");
  assert.match(css, /@keyframes out \{ to \{ opacity: 0;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.in \{ animation: none; \} \.out \{ display: none; \} \}/);
  assert.doesNotMatch(roll, /setTimeout|setInterval|requestAnimationFrame|fetch\(/, "no clock of its own");
});

test("below 1024px the board is a row to swipe, led by a compact leader; the big card is for 1024px and up", () => {
  const css = read("./TrendingStrip.module.css");
  // 280px cards that snap at the left edge, running to the page's edges, with room for a chip on a card's edge; the grid from 1024px
  assert.match(css, /\.board \{ display: flex; gap: 12px; margin-inline: calc\(var\(--page-pad, 1rem\) \* -1\); padding: 12px var\(--page-pad, 1rem\) 14px; overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x mandatory;/);
  assert.match(css, /\.board > li \{ flex: none; width: 280px; scroll-snap-align: start; \}/);
  assert.match(css, /@media \(min-width: 1024px\) \{\n\s*\.board \{ display: grid; margin-inline: 0; padding: 0; overflow: visible; scroll-snap-type: none; \}\n\s*\.board > li \{ width: auto; \}/);
  assert.match(board, /className=\{`\$\{styles\.board\} lg:grid-cols-10 lg:grid-rows-2`\}/);
  assert.doesNotMatch(board, /SPAN_SM|sm:grid-cols-2|sm:col-span-2/, "no two-column tablet grid any more");
  // both leaders are always in the page and CSS shows one, so nothing differs between the server and the browser
  assert.match(board, /<div className="hidden h-full lg:block"><Leader key=\{launchKey\(first\)\}/);
  assert.match(board, /<div className="h-full lg:hidden"><Runner key=\{launchKey\(first\)\} lead row=\{first\} rank=\{1\}/);
  // the compact leader says "New leader" for a few seconds, as the big card does, and focus never returns to the hidden twin
  assert.match(board, /const handover = lead && from !== null && now - from\.since < HANDOVER_LIFE_MS;/);
  assert.match(board, /styles\.move\}>New leader</);
  assert.match(board, /\.filter\(\(card\) => card\.getClientRects\(\)\.length > 0\);/);
});

test("on phones the live panel says what it is in one line and shows less, without losing its name for assistive tech", () => {
  assert.match(river, /<span aria-hidden="true" className="sm:hidden">Live now<\/span><span className="sr-only sm:not-sr-only">Live on \{WHERE\}<\/span>/);
  assert.match(river, /<li className="max-sm:hidden">Bigger bubble, more dollars traded<\/li>/, "the legend fits one row");
  const bubbles = read("./LiveBubbles.module.css");
  assert.match(bubbles, /\.field \{\n\s*position: relative;\n\s*height: 250px;/);
  assert.match(bubbles, /@media \(min-width: 640px\) \{\n\s*\.field \{ height: 320px; \}/);
});

