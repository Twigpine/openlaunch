import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** Every market-cap site renders the dollar-first display and never drops the "no USD price" mark (CodeRabbit, PR #27). */
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the home row shows the quote detail on every width", () => {
  const row = read("./LaunchRow.tsx");
  assert.match(row, /const cap = capDisplay\(l\.fdv_quote, l\.quote_usd/);
  assert.equal((row.match(/>\{cap\.detail\}</g) ?? []).length, 2, "one rendered detail line for desktop, one for mobile");
  assert.match(row, /md:hidden"><span className="block truncate[^"]*" title=\{capDetail\}>\{cap\.detail\}<\/span>/, "the mobile block carries the detail");
});

test("one-string sites use the compact form, which carries the mark for an unpriced quote", () => {
  for (const [file, expected] of [["./MeDashboard.tsx", 2], ["./LaunchCard.tsx", 1]] as const) {
    const src = read(file);
    assert.equal((src.match(/capDisplay\([^)]*\)\.compact/g) ?? []).length, expected, `${file} uses .compact`);
    assert.doesNotMatch(src, /capDisplay\([^)]*\)\.main/, `${file} never renders .main alone`);
  }
});

test("the token page leads with dollars and keeps the quote detail; the phone bar uses the compact form", () => {
  const page = read("../../app/t/[chain]/[token]/page.tsx");
  assert.match(page, /const cap = capDisplay\(l\.fdv_quote, l\.quote_usd, /);
  assert.match(page, />\{cap\.main\}<\/p>\r?\n\s*<p [^>]*>\{cap\.detail\}<\/p>/, "the header shows the quote detail under the dollar figure");
  assert.match(page, /<MobileBuyBar symbol=\{l\.symbol\} mcap=\{cap\.compact\} \/>/);
  assert.doesNotMatch(page, /capDisplay\([^)]*\)\.main/);
});

test("the Trending board leads with the main figure and keeps the mark in sight on every card", () => {
  const board = read("./TrendingStrip.tsx");
  assert.match(board, /const cap = \(row: LaunchRow\) => capDisplay\(row\.fdv_quote, row\.quote_usd/);
  assert.equal((board.match(/<\/span>\{c\.main\}/g) ?? []).length, 2, "the leader's figure and a runner's");
  assert.match(board, /Market cap\{c\.usd === null \? ` \(\$\{c\.detail\}\)` : ""\}, and the change since launch/, "the leader's caption carries the mark");
  assert.match(board, /\{a\.volume\}<\/span>\{c\.usd === null \? <> · \{c\.detail\}<\/> : null\}/, "a runner carries it beside its volume, which shows on every width");
  assert.equal((board.match(/title=\{`Market cap \$\{c\.main\} · \$\{c\.detail\}`\}/g) ?? []).length, 2, "both figures keep the other denomination on hover");
  assert.doesNotMatch(board, /\.compact\b/, "the one-string form pushed the token's name out of a runner card");
});

test("the launch form renders main + detail for the opening cap, the preview card and the post-buy estimate", () => {
  const form = read("./LaunchForm.tsx");
  assert.equal((form.match(/cap\(fdvPreview\)\.main/g) ?? []).length, 2);
  assert.equal((form.match(/cap\(fdvPreview\)\.detail/g) ?? []).length, 2);
  assert.match(form, /cap\(buyPreview\.fdvAfter\)\.main\}<\/span><span[^>]*> · \{cap\(buyPreview\.fdvAfter\)\.detail\}/);
  assert.doesNotMatch(form, /fmtMcap\(/, "the old quote-first formatter is gone");
});
