import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { en, messagesFor } from "../../i18n/messages/index.ts";
import { NO_USD_PRICE, capDisplay } from "../../lib/launchpad/market-cap.ts";

/** Every market-cap site renders the dollar-first display and never drops the "no USD price" mark (CodeRabbit, PR #27). */
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the market list words the mark in the reader's language and keeps it on an unpriced cap", () => {
  const row = read("./LaunchRow.tsx");
  // the detail and the one-string form both carry the mark; a priced cap is returned as it is
  assert.match(row, /return cap\.usd !== null \? cap : \{ \.\.\.cap, detail: noUsdPrice, compact: `\$\{cap\.main\} · \$\{noUsdPrice\}` \};/);
  assert.equal(en.market.noUsdPrice, NO_USD_PRICE, "English reads exactly as capDisplay's own mark");
  assert.ok(messagesFor("zh-CN").market.noUsdPrice.includes("美元"));
});

test("the home row shows the quote detail on every width", () => {
  const row = read("./LaunchRow.tsx");
  assert.match(row, /const cap = localizedCap\(capDisplay\(l\.fdv_quote, l\.quote_usd, [^)]*\), t\("noUsdPrice"\)\);/);
  assert.equal((row.match(/>\{cap\.detail\}</g) ?? []).length, 2, "one rendered detail line for desktop, one for mobile");
  assert.match(row, /md:hidden"><span className="block truncate[^"]*" title=\{capDetail\}>\{cap\.detail\}<\/span>/, "the mobile block carries the detail");
});

test("one-string sites use the compact form, which carries the mark for an unpriced quote", () => {
  const dashboard = read("./MeDashboard.tsx");
  assert.equal((dashboard.match(/capDisplay\([^)]*\)\.compact/g) ?? []).length, 2, "MeDashboard uses .compact");
  assert.doesNotMatch(dashboard, /capDisplay\([^)]*\)\.main/, "MeDashboard never renders .main alone");
  const card = read("./LaunchCard.tsx");
  assert.equal((card.match(/localizedCap\(capDisplay\([^)]*\), t\("noUsdPrice"\)\)\.compact/g) ?? []).length, 1, "LaunchCard uses .compact");
  assert.doesNotMatch(card, /capDisplay\([^)]*\)[^\n;]*\.main/, "LaunchCard never renders .main alone");
});

test("the token page leads with dollars and keeps the quote detail; the phone bar uses the compact form", () => {
  const page = read("../../app/t/[chain]/[token]/page.tsx");
  assert.match(page, /const cap = capDisplay\(l\.fdv_quote, l\.quote_usd, /);
  // an unpriced cap's mark is worded in the reader's language; in English it reads as capDisplay's own
  assert.match(page, />\{cap\.main\}<\/p>\r?\n\s*<p [^>]*>\{cap\.usd === null \? t\("page\.noUsdPrice"\) : cap\.detail\}<\/p>/, "the header shows the quote detail under the dollar figure");
  assert.match(page, /<MobileBuyBar symbol=\{l\.symbol\} mcap=\{cap\.usd === null \? t\("page\.capUnpriced", \{ cap: cap\.main \}\) : cap\.compact\} \/>/);
  assert.equal(en.token.page.noUsdPrice, NO_USD_PRICE);
  const unpriced = capDisplay(1_200_000, null, { key: "other", symbol: "FOO", decimals: 18 });
  assert.equal(en.token.page.capUnpriced.replace("{cap}", unpriced.main), unpriced.compact);
  assert.doesNotMatch(page, /capDisplay\([^)]*\)\.main/);
});

test("the Trending board leads with the main figure and keeps the mark in sight on every card", () => {
  const board = read("./TrendingStrip.tsx");
  assert.match(board, /const cap = \(row: LaunchRow\) => capDisplay\(row\.fdv_quote, row\.quote_usd/);
  assert.equal((board.match(/const c = localizedCap\(cap\(row\), tm\("noUsdPrice"\)\);/g) ?? []).length, 2, "the leader and a runner word the mark for the reader");
  assert.equal((board.match(/<\/span><Roll text=\{c\.main\} \/>/g) ?? []).length, 2, "the leader's figure and a runner's");
  assert.match(board, /c\.usd === null \? t\("capCaptionUnpriced", \{ detail: c\.detail \}\) : t\("capCaption"\)/, "the leader's caption carries the mark");
  assert.equal(en.market.trending.capCaptionUnpriced, "Market cap ({detail}), and the change since launch");
  assert.equal(en.market.trending.capCaption, "Market cap, and the change since launch");
  assert.match(board, /<Roll text=\{a\.volume\} \/><\/span>\{c\.usd === null \? <> · \{c\.detail\}<\/> : null\}/, "a runner carries it beside its volume, which shows on every width");
  assert.equal((board.match(/title=\{t\("capTitle", \{ cap: c\.main, detail: c\.detail \}\)\}/g) ?? []).length, 2, "both figures keep the other denomination on hover");
  assert.equal(en.market.trending.capTitle, "Market cap {cap} · {detail}");
  assert.doesNotMatch(board, /\.compact\b/, "the one-string form pushed the token's name out of a runner card");
});

test("the launch form renders main + detail for the opening cap, the preview card and the post-buy estimate", () => {
  const form = read("./LaunchForm.tsx");
  assert.equal((form.match(/cap\(fdvPreview\)\.main/g) ?? []).length, 2);
  assert.equal((form.match(/cap\(fdvPreview\)\.detail/g) ?? []).length, 2);
  assert.match(form, /cap\(buyPreview\.fdvAfter\)\.main\}<\/span><span[^>]*> · \{cap\(buyPreview\.fdvAfter\)\.detail\}/);
  assert.doesNotMatch(form, /fmtMcap\(/, "the old quote-first formatter is gone");
});
