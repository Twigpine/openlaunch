import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("market and watchlist live on the workspace rather than in enclosing cards", () => {
  for (const path of ["./launchpad/LaunchList.tsx", "./launchpad/WatchlistPanel.tsx"]) {
    const opening = source(path).match(/<section aria-labelledby=[^>]+>/)?.[0];
    assert.ok(opening);
    assert.doesNotMatch(opening, /rounded|border|overflow-hidden/);
  }
});

test("the compact chain selector retains keyboard selection and automatic close", () => {
  const selector = source("./launchpad/ChainSelector.tsx");
  assert.match(selector, /Popover open=\{open\} onOpenChange=\{setOpen\}/);
  assert.match(selector, /aria-label=\{`\$\{label\}:/);
  assert.match(selector, /orientation="vertical"/);
  assert.match(selector, /onChange\(values\[0\] === "all" \? null/);
  assert.match(selector, /setOpen\(false\)/);
  assert.match(selector, /\[null, \.\.\.VISIBLE_CHAINS\]/);
  assert.match(source("./vendor/popover.tsx"), /@base-ui\/react\/popover/);
  assert.match(source("./vendor/popover.tsx"), /collisionPadding=\{12\}/);
  assert.match(source("./vendor/popover.tsx"), /motion-reduce:transition-none/);
});

test("secondary filters remain accessible and active filtering is visible outside the popup", () => {
  const list = source("./launchpad/LaunchList.tsx");
  assert.match(list, /<PopoverTrigger[^>]+>[\s\S]+?Filters/);
  assert.match(list, /<PopoverTitle[^>]+>Filter launches/);
  assert.match(list, /aria-label="Quick filter" orientation="vertical"/);
  assert.match(list, /aria-label="Clear active filter"/);
  assert.match(list, /<PopoverTrigger ref=\{filtersTriggerRef\}/);
  assert.match(list, /pick\(sort, window_, chain, null\); filtersTriggerRef\.current\?\.focus\(\)/);
  assert.match(list, /aria-label="Volume window"/);
  assert.match(list, /s\.key === "new"/);
});

test("tablet rows use three decision tracks before the four-column desktop market tape", () => {
  const css = source("../app/globals.css");
  assert.match(css, /@media \(min-width: 640px\) \{\s*\.launch-ledger/);
  assert.match(css, /@media \(min-width: 1024px\) \{\s*\.launch-ledger/);
  const row = source("./launchpad/LaunchRow.tsx");
  assert.match(row, /hidden sm:grid/);
  assert.match(row, /styles\.mobileMetrics/);
  assert.match(row, /hidden lg:block/);
  assert.doesNotMatch(row.match(/<dl className=[^>]+>/)?.[0] ?? "", /border-/);
});

test("shared toggles have individually selected states without an enclosing tray", () => {
  const toggle = source("./vendor/toggle-group.tsx");
  const group = toggle.match(/data-slot="toggle-group"[^\n]+/)?.[0] ?? "";
  assert.doesNotMatch(group, /border|rounded|bg-card/);
  assert.match(toggle, /data-pressed:bg-line data-pressed:text-ink/);
  assert.match(toggle, /@base-ui\/react\/toggle-group/);
});
