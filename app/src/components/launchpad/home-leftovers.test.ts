import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contracts for three leftovers of the home redesign: token names that collapsed beside their quote badge on
 * phones and tablets, the star button's hidden second tab stop (and the hydration warning it caused), and a stale comment on /rules.
 * Browser QA measures the widths and the tab order; these keep the fixes from being edited away.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const row = read("./LaunchRow.tsx");
const watch = read("./WatchButton.tsx");
const rules = read("../../app/rules/page.tsx");

test("below 1024px the quote badge drops under the token name instead of squeezing it", () => {
  // wraps only where the name column is narrow (phones, and the tablet table from 768 to about 850px); unchanged from 1024px up
  assert.match(row, /<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0\.5 lg:flex-nowrap">\n\s*<MorphName /, "the name line wraps below lg");
  assert.doesNotMatch(row, /<div className="flex min-w-0 items-center gap-2">\n\s*<MorphName /, "the single-line name row is gone");
  // the name still truncates, and every badge keeps its width, so the badge is what moves
  assert.match(row, /<span className="truncate text-sm font-semibold text-ink">\{l\.name\}<\/span>/);
  assert.match(row, /<QuoteBrandBadge quoteKey=\{l\.quote_key\} \/>\n\s*\{l\.quote_key === "other" \? <UnlistedPairBadge symbol=\{l\.quote_symbol\} className="shrink-0" \/> : null\}/);
});

test("the phone grid's Buys / sells value stays on one line; the desktop column keeps its two-line wrap", () => {
  const value = /<span className="text-up">\{l\.buys\}<\/span><span className="text-muted"> \/ <\/span>(?:<span className="sr-only">Sells <\/span>)?<span className="text-down-ink">\{l\.sells\}<\/span>/g;
  assert.equal((row.match(value) ?? []).length, 2, "one value for the desktop column, one for the phone grid");
  assert.match(row, /<dt className="text-\[10px\] text-muted">Buys \/ sells<\/dt><dd className="mt-1 whitespace-nowrap font-mono text-\[11px\] tnum"><span className="text-up">\{l\.buys\}<\/span>/, "the phone value");
  // the desktop column is 5rem: a busy token's counts would overhang it on one line, so they wrap after the slash as before
  assert.doesNotMatch(row, /<span className="whitespace-nowrap"><span className="sr-only">Buys /, "no forced single line in the desktop column");
});

test("the star button is one tab stop, with or without reduced motion", () => {
  // motion makes an element with a tap gesture focusable (tabindex="0"); the gesture was off under reduced motion, so
  // the attribute also differed between the server and the client, and a click left focus on the span. No gesture on
  // the span at all: the press feedback is the button's own :active state.
  const spans = watch.match(/<motion\.span [^>]*>/g) ?? [];
  assert.equal(spans.length, 1);
  assert.doesNotMatch(watch, /whileTap|whileHover|whileFocus|onTap/, "nothing that makes motion add a tab stop");
  assert.doesNotMatch(watch, /tabIndex=/, "the button's native tab stop is the only one, and nothing inside it can take focus");
  assert.match(spans[0], /group-active\/star:scale-\[\.88\]/, "the press feedback stays");
  assert.match(spans[0], /motion-reduce:group-active\/star:scale-100/, "and is off under reduced motion");
  assert.match(watch, /<button type="button" disabled=\{!ready\} aria-label=\{label\} aria-pressed=\{saved\}/);
  assert.match(watch, /className=\{`group\/star /);
});

test("the rules page says the walk-through opens the home page again", () => {
  assert.doesNotMatch(rules, /used to open the home page/);
  assert.match(rules, /\{\/\* the animated walk-through that also opens the home page: token, pool, lock \*\/\}\n\s*<div className=\{styles\.machine\}><LaunchMachine \/><\/div>/);
});
