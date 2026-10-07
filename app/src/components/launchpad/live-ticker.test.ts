import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contracts for the line that closes the hero. It is a pulse, not content: chains and dollar amounts only
 * (no token name or picture in the hero's own space), the poll is its clock, and it never needs a timer.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const ticker = read("./LiveTicker.tsx");
const css = read("./LiveTicker.module.css");
const hero = read("./LaunchHero.tsx");

test("the ticker names a chain and a dollar amount, never a token", () => {
  assert.doesNotMatch(ticker, /\.name\b|\.symbol\b|image_url|TokenAvatar|\.trader\b/, "no token name, symbol, picture or wallet");
  assert.match(ticker, /const chain = CHAIN_LABELS\[item\.chain\];/, "a chain in full, never the bare broker name");
  assert.match(ticker, /\$\{item\.is_buy \? "Buy" : "Sell"\}\$\{item\.usd !== null \? ` \$\{riverUsd\(item\.usd\)\}` : ""\} on \$\{chain\}/);
  assert.match(ticker, /`New launch on \$\{chain\}`/);
});

test("it shows the newest event worth a line and links to that token", () => {
  assert.match(ticker, /live\.feed\.find\(\(e\) => e\.kind === "launch" \|\| e\.usd === null \|\| e\.usd >= 1\) \?\? live\.feed\[0\]/);
  assert.match(ticker, /href=\{`\/t\/\$\{item\.chain\}\/\$\{item\.token\}`\}/);
  assert.match(ticker, /if \(!item\) return null;/, "an empty feed draws nothing");
});

test("the poll is the clock: no timer, no request, and a new event replays its entrance on its own key", () => {
  assert.doesNotMatch(ticker, /setTimeout|setInterval|requestAnimationFrame|\bfetch\s*\(/);
  assert.match(ticker, /const \{ live \} = useLive\(\);/);
  assert.match(ticker, /ago\(item\.at, live\.at\)/);
  assert.match(ticker, /<Link key=\{feedKey\(item\)\}/);
  assert.match(css, /\.enter \{ animation: tickerIn 320ms [^}]*backwards; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.enter \{ animation: none; \}/);
  assert.doesNotMatch(css, /infinite/, "no ambient animation");
});

test("the live line is the grid's last row up to 1023px and the locker's caption from 1024px", () => {
  // two renderings of the same one-link component, one shown per size: the hidden one is display:none, so nothing reads or tabs twice
  assert.match(hero, /<LiveTicker className=\{styles\.tickerStage\} \/>\n\s*<\/div>\n\s*<div className=\{styles\.totalsArea\}>/, "inside the locker's column, right after the stage frame");
  assert.match(hero, /<LiveTicker className=\{styles\.tickerArea\} \/>\n\s*<\/div>\n\s*<\/section>/, "and the last child of the grid, which is the last thing in the hero");
  const grid = read("./LaunchHero.module.css");
  assert.match(grid, /grid-template-areas: "copy" "stage" "totals" "ticker";/);
  assert.match(grid, /grid-template-areas: "copy stage" "totals totals" "ticker ticker";/, "tablets: under both columns, as it always was");
  assert.match(grid, /@media \(min-width: 1024px\) \{\n\s*\.layout \{ grid-template-areas: "copy stage" "totals stage";/, "laptops: no row of its own, so the hero is a row shorter");
  // below 1024px the line sits 16px (phones) or 20px under the grid, as it did when it was outside it: negative margins against the 20px and 32px row gaps
  assert.match(grid, /\.tickerArea \{ grid-area: ticker; min-width: 0; margin-top: -0\.25rem; \}/);
  assert.match(grid, /\.tickerArea \{ margin-top: -0\.75rem; \}/);
  assert.match(grid, /\.stageCol \{ display: contents; \}/, "below 1024px the column only wraps the stage");
  assert.match(grid, /\.layout \.tickerStage \{ display: none; \}/);
  assert.match(grid, /\.layout \.tickerArea \{ display: none; \}\n\s*\.stageCol \{ display: flex; flex-direction: column; gap: 0\.875rem; grid-area: stage; align-self: center; min-width: 0; \}\n\s*\.layout \.tickerStage \{ display: flex; \}/);
  assert.doesNotMatch(read("./hero-layout.ts"), /ticker:/, "no spacing constant outside the grid any more");
});
