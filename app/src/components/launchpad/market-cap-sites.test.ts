import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** Every market-cap site renders the dollar-first display and never drops the "no USD price" mark (CodeRabbit, PR #27). */
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the home row shows the quote detail on every width", () => {
  const row = read("./LaunchRow.tsx");
  assert.match(row, /const cap = capDisplay\(l\.fdv_quote, l\.quote_usd/);
  assert.equal((row.match(/>\{cap\.detail\}</g) ?? []).length, 1, "one responsive detail line serves every width");
  assert.match(row, /className=\{styles\.capDetail\} title=\{capDetail\}>\{cap\.detail\}<\/span>/, "the shared market cell carries the quote detail");
});

test("one-string sites use the compact form, which carries the mark for an unpriced quote", () => {
  for (const [file, expected] of [["./TrendingStrip.tsx", 1], ["./MeDashboard.tsx", 2], ["../../app/t/[chain]/[token]/page.tsx", 1]] as const) {
    const src = read(file);
    assert.equal((src.match(/capDisplay\([^)]*\)\.compact/g) ?? []).length, expected, `${file} uses .compact`);
    assert.doesNotMatch(src, /capDisplay\([^)]*\)\.main/, `${file} never renders .main alone`);
  }
});

test("the launch form renders main + detail for the opening cap, the preview card and the post-buy estimate", () => {
  const form = read("./LaunchForm.tsx");
  assert.equal((form.match(/cap\(fdvPreview\)\.main/g) ?? []).length, 2);
  assert.equal((form.match(/cap\(fdvPreview\)\.detail/g) ?? []).length, 2);
  assert.match(form, /cap\(buyPreview\.fdvAfter\)\.main\}<\/span><span[^>]*> · \{cap\(buyPreview\.fdvAfter\)\.detail\}/);
  assert.doesNotMatch(form, /fmtMcap\(/, "the old quote-first formatter is gone");
});
