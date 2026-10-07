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

test("the hero ends on the ticker", () => {
  assert.match(hero, /<LiveTicker className=\{HERO\.ticker\} \/>\n\s*<\/section>/);
});
