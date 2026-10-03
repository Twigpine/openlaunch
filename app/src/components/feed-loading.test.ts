import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contracts for the /feed route skeleton. The loader must keep the same shell, intro, two-column
 * layout and post anatomy as the real page, otherwise the page jumps when posts stream in.
 */
const loading = readFileSync(new URL("../app/feed/loading.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/feed/page.tsx", import.meta.url), "utf8");
const feed = readFileSync(new URL("./sections/CommunityFeed.tsx", import.meta.url), "utf8");
const skeleton = readFileSync(new URL("./Skeleton.tsx", import.meta.url), "utf8");
const homeLoading = readFileSync(new URL("../app/(home)/loading.tsx", import.meta.url), "utf8");

test("the /feed skeleton borrows the real page's CSS modules instead of hand-rolled widths", () => {
  assert.match(loading, /from "@\/components\/sections\/SectionShell\.module\.css"/);
  assert.match(loading, /from "@\/components\/sections\/CommunityFeed\.module\.css"/);
  assert.match(page, /styles\.page\b/, "the real page uses the section shell");
  assert.doesNotMatch(loading, /max-w-3xl/, "the old single-column loader width is gone");
  assert.match(loading, /aria-busy="true"/);
});

test("the /feed skeleton mirrors every layout region of FeedPage + CommunityFeed", () => {
  for (const cls of ["shell.page", "shell.intro", "shell.introRow", "shell.introCopy", "shell.panel"]) {
    assert.match(loading, new RegExp(`className=\\{[^}]*\\b${cls.replace(".", "\\.")}\\b`), `loader uses ${cls}`);
  }
  for (const cls of ["layout", "controls", "toolbar", "filters", "resultLine", "feedFoot", "aside", "guide", "steps", "note", "caution"]) {
    assert.match(loading, new RegExp(`\\bstyles\\.${cls}\\b`), `loader uses styles.${cls}`);
    assert.match(feed, new RegExp(`\\bstyles\\.${cls}\\b`), `CommunityFeed still defines the region styles.${cls}`);
  }
  // Regions appear in the same order as the real markup.
  const order = ["shell.intro", "styles.layout", "shell.panel", "styles.controls", "styles.toolbar", "styles.filters", "styles.resultLine", "<SkFeedPost", "styles.feedFoot", "styles.aside", "styles.guide", "styles.note"];
  const positions = order.map((token) => loading.indexOf(token));
  assert.ok(positions.every((p) => p >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "loader regions are in page order");
});

test("the /feed skeleton renders full feed posts, not the compact sidebar rows", () => {
  assert.match(loading, /<SkFeedPost key=\{i\} i=\{i\} \/>/);
  assert.doesNotMatch(loading, /<SkPost\b/);
  const count = Number(loading.match(/Array\.from\(\{ length: (\d+) \}, \(_, i\) => \(\s*<SkFeedPost/)?.[1]);
  assert.ok(count >= 4 && count <= 8, `a viewport's worth of posts, got ${count}`);
});

test("SkFeedPost matches the real post anatomy: 40px round avatar, body, 20px token tile, conversation line", () => {
  const block = skeleton.slice(skeleton.indexOf("export function SkFeedPost"), skeleton.indexOf("export function Spinner"));
  assert.ok(block.length > 0);
  assert.match(block, /h-10 w-10 shrink-0 rounded-full/, "40px wallet avatar");
  assert.match(block, /h-5 w-5 shrink-0 rounded-md/, "20px token tile");
  assert.match(block, /py-6 sm:py-7/, "open rows match the feed spacing");
  assert.doesNotMatch(block, /px-[1-9]|sm:p-[1-9]/, "post loading has no horizontal card inset");
  assert.match(feed, /<WalletAvatar address=\{post\.wallet\} size=\{40\}/);
  assert.match(feed, /<TokenAvatar[^>]*size=\{20\}/);
  assert.match(block, /mt-\[18px\]/, "body and meta keep the 18px rhythm of .postBody / .postMeta");
});

test("home sidebar skeletons match the compact posts widget and the launch tape", () => {
  assert.match(homeLoading, /<SkPost key=\{i\} i=\{i\} avatar="tile" \/>/, "launch tape rows use the square token tile");
  assert.match(homeLoading, /Array\.from\(\{ length: 5 \}, \(_, i\) => \(\s*<SkPost key=\{i\} i=\{i\} \/>/, "posts widget shows COMPACT_LIMIT rows");
  assert.match(homeLoading, /min-h-14 items-center justify-between/, "56px widget headers");
  const compact = skeleton.slice(skeleton.indexOf("export function SkPost"), skeleton.indexOf("export function SkFeedPost"));
  assert.match(compact, /h-7 w-7 shrink-0/, "28px avatar like PostsFeed compact / LaunchTape");
});
