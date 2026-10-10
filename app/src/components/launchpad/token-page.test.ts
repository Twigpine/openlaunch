import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contracts for the token page: its tint, the Proof panel, price impact in the trade box and the chart
 * sources. The math is unit-tested beside each module (tint, proof, price-impact, chart-terminal).
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const page = read("../../app/t/[chain]/[token]/page.tsx");
const panel = read("./TradePanel.tsx");
const chart = read("./TokenChart.tsx");
const tintServer = read("../../lib/launchpad/tintServer.ts");
const about = read("./TokenAbout.tsx");

test("the tint comes from the stored logo by key, per theme, and never reaches an action", () => {
  assert.match(page, /tokenTint\(l\.image_url, l\.token\)/);
  assert.match(page, /\[--tok:var\(--tok-light\)\][^"]*dark:\[--tok:var\(--tok-dark\)\]/);
  assert.match(page, /style=\{\{ borderColor: "var\(--tok\)" \}\}/, "the ring takes the tint");
  assert.match(tintServer, /storedImageKey\(image\)/);
  assert.match(tintServer, /await readImage\(key\)/);
  assert.doesNotMatch(tintServer, /\bfetch\s*\(/, "a logo is read from our store, never fetched from a URL");
  assert.doesNotMatch(panel, /--tok/, "buttons stay in the action colours");
});

test("the Proof panel is built from facts with a link for each, holder facts gated on the index", () => {
  assert.match(page, /proofFacts\(\{ holders, symbol: l\.symbol, launcher: l\.launcher, launcherName: names\[l\.launcher\.toLowerCase\(\)\]\?\.u \?\? null, lpFee: l\.lp_fee, mode, recipients: l\.recipients\.length \}\)/);
  for (const key of ["lock", "creator", "spread", "launch", "fees"]) assert.match(page, new RegExp(`${key}: \\{ href: `), `link for ${key}`);
  assert.match(page, /bar=\{proof\.holdersReady && holders \?/);
});

test("price impact uses the pool's own spot and fee, and a big move takes a second tap outside trade()", () => {
  assert.match(panel, /functionName: "getSlot0", args: \[poolId\]/);
  assert.match(panel, /priceImpact\(\{ sqrtPriceX96: fresh\.sqrtPriceX96, amountIn, amountOut: fresh\.out, zeroForOne: side === "buy", feePips: poolKey\.fee \}\)/);
  assert.match(panel, /if \(level === "confirm" && armed !== quoteKey\) \{ setArmed\(quoteKey\); return; \}/);
  assert.match(panel, /onClick=\{onTrade\}/);
  const trade = panel.slice(panel.indexOf("async function trade()"), panel.indexOf("const outLabel"));
  assert.doesNotMatch(trade, /armed|impact/, "trade() keeps its synchronous lock as the first thing it does");
  assert.match(panel, /Sell it all now/);
});

test("our on-chain chart is the default; GeckoTerminal is checked only when asked for and framed safely", () => {
  assert.match(chart, /useState<"onchain" \| "gecko">\("onchain"\)/);
  assert.doesNotMatch(chart, /useEffect/, "no lookup on page load");
  assert.match(chart, /if \(next === "gecko" && lookup !== "ready" && lookup !== "checking"\) void check\(\);/);
  assert.match(chart, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(chart, /allow-top-navigation|dangerouslySetInnerHTML|useAccount/);
  assert.match(page, /hasTrades=\{l\.buys \+ l\.sells > 0\}/);
});

test("the About card sits under the trade box and links only checked socials", () => {
  assert.match(page, /<BorderBeam [^\n]*\/>\n\s*<\/div>\n\s*\{\/\* the token at a glance[^\n]*\*\/\}\n\s*<TokenAbout /);
  assert.match(about, /const \{ x, site, host \} = safeSocials\(\{ website, x_handle \}\);/);
  assert.match(about, /rel="noopener noreferrer nofollow"/);
});

test("the trades scroller is the containing block for its sr-only labels, so a long tape adds no blank page height", () => {
  const trades = read("./TokenTrades.tsx");
  // every row carries an absolutely positioned sr-only label; without a positioned scroller they escape its clipping and stretch the page
  assert.match(trades, /<span className="sr-only">View transaction, <\/span>/);
  assert.match(trades, /<div className="relative max-h-\[480px\] overflow-auto bb-scroll"/);
});
