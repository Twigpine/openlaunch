import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("market tape uses consumer-grade hierarchy and descriptive activity without nested actions", () => {
  const row = source("./launchpad/LaunchRow.tsx");
  assert.match(row, /className=\{styles\.shell\}/);
  assert.match(row, /<ActivitySignal buys=\{l\.buys\} sells=\{l\.sells\} holders=\{l\.holders\}/);
  assert.match(row, /buys === 1 \? "buy" : "buys"/);
  assert.match(row, /const exact = `\$\{buys\} \$\{buyWord\}, \$\{sells\} \$\{sellWord\}`/);
  assert.match(row, /title="0 buys, 0 sells"[^>]*>[\s\S]*No trades/);
  assert.match(row, /styles\.capValue/);
  assert.doesNotMatch(row, /ArrowUpRight|avatarFrame|activityTrack|buyWidth|sellWidth/);
  assert.equal((row.match(/className=\{styles\.context\}/g) ?? []).length, 1, "ranking context is rendered once at every width");
  assert.match(row, /<span className="sr-only">Launched <\/span>/);
  assert.match(row, /<span className="sr-only">Rank \{rank\}\. <\/span><span aria-hidden="true" className=\{styles\.rank\}>/);
  assert.match(row, /className="sr-only">\{`\$\{holders\} \$\{holders === 1 \? "holder" : "holders"\}\. `\}/);
  assert.match(source(".\/launchpad\/LaunchList.tsx"), /className="sr-only">Quiet launches\. No buyer activity yet\. One visible launch per wallet/);
  const rowCss = source("./launchpad/LaunchRow.module.css");
  assert.match(rowCss, /\.shell\s*\{[^}]*border-bottom:/);
  assert.match(rowCss, /\.row:hover::before,[\s\S]*\.row:focus-visible::before/);
  assert.match(rowCss, /\.row:hover::after,[\s\S]*\.row:focus-visible::after/);
  assert.match(rowCss, /width: 2px/);
  assert.match(rowCss, /content-visibility:\s*auto/);
  assert.match(rowCss, /\.mobileMetrics \.activity \{[^}]*flex-wrap: wrap/);
  assert.match(rowCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(row, /<div className=\{styles\.watch\}><WatchButton[^>]* \/><\/div>\s*<Link/);
});

test("market loading mirrors the live ledger anatomy", () => {
  const skeleton = source("./Skeleton.tsx");
  assert.match(skeleton, /relative min-h-\[5\.25rem\] border-b border-line py-3 pl-12 pr-3/);
  assert.match(skeleton, /h-11 w-11 shrink-0 rounded-xl/);
  assert.match(skeleton, /col-span-2 grid grid-cols-2 items-end gap-3 sm:hidden/);
  assert.match(source("../app\/\(home\)\/loading.tsx"), /market-toolbar grid grid-cols-\[minmax\(0,1fr\)_auto\]/);
});

test("the launch browser has one calm market header and a measured view switch", () => {
  const browser = source("./launchpad/LaunchBrowser.tsx");
  const css = source("./launchpad/LaunchBrowser.module.css");
  assert.match(browser, /Markets, live onchain\./);
  assert.match(browser, /From first block to first buyer, every launch stays visible\./);
  assert.match(browser, /<TabsList aria-label="Launch browser"/);
  assert.match(css, /\.viewTabs :global\(\.ui-tab-indicator\)/);
  assert.match(css, /@media \(max-width: 639px\)/);
});

test("financial font is shared with the error document and self-hosted by Next", () => {
  assert.match(source("../app/fonts.ts"), /Geist_Mono\(\{ subsets: \["latin"\], variable: "--font-geist-mono"/);
  for (const path of ["../app/layout.tsx", "../app/global-error.tsx"]) {
    assert.match(source(path), /geistMono\.variable/);
  }
});

test("shared motion is finite, optional on press, and tabs retain native primitive semantics", () => {
  const css = source("../app/globals.css");
  assert.match(css, /--ui-control-duration: 160ms/);
  assert.match(css, /--ui-panel-duration: 220ms/);
  assert.match(css, /\.ui-pressable:active:not\(:disabled\):not\(\[aria-disabled="true"\]\) \{ transform: none; \}/);
  const tabs = source("./vendor/tabs.tsx");
  assert.match(tabs, /TabsPrimitive\.Indicator className="ui-tab-indicator motion-reduce:transition-none"/);
  assert.match(tabs, /TabsPrimitive\.Tab/);
  assert.match(source("./launchpad/LaunchBrowser.tsx"), /keepMounted/);
});
