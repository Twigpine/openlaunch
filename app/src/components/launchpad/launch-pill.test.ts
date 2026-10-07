import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contracts for the phone's Launch pill. The header has no Launch button on a phone (it lives in the menu), so after
 * the hero's button scrolls away the page has nothing to act on. The pill fills that gap, and only that gap.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const pill = read("./LaunchPill.tsx");
const css = read("./LaunchPill.module.css");

test("it shows only while the hero's own button is mounted and fully off screen, and not over the footer", () => {
  assert.match(pill, /useSyncExternalStore\(subscribeHeroCta, heroCtaOnScreen, \(\) => null\)/);
  assert.match(pill, /if \(heroButton !== false \|\| atFooter\) return null;/);
  assert.match(pill, /document\.getElementById\("site-footer"\)/);
  assert.match(pill, /new IntersectionObserver\(\(\[entry\]\) => setAtFooter\(entry\.isIntersecting\)\)/);
  assert.doesNotMatch(pill, /setTimeout|setInterval|requestAnimationFrame|\bfetch\s*\(/);
});

test("it is one filled link to /launch with a real name, drawn on phones only, under the header and its menu", () => {
  assert.match(pill, /<Link href="\/launch" className=\{styles\.pill\}>/);
  assert.match(pill, /Launch a token\n\s*<\/Link>/);
  assert.match(css, /\.pill \{ position: fixed; z-index: 30;/, "the header is z 40 and its phone menu z 50");
  assert.match(css, /bottom: max\(16px, env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /@media \(min-width: 640px\) \{ \.pill \{ display: none; \} \}/, "from 640px the header carries the button");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.pill \{ animation: none; \} \}/);
  assert.doesNotMatch(css, /infinite/, "no ambient motion");
});

test("the home page mounts it once", () => {
  const home = read("../../app/(home)/page.tsx");
  assert.equal((home.match(/<LaunchPill \/>/g) ?? []).length, 1);
  assert.match(home, /import LaunchPill from "@\/components\/launchpad\/LaunchPill";/);
});
