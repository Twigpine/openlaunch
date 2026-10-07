import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { COIN_LIFE_MS } from "../../lib/launchpad/hero-coin.ts";

/**
 * Source contracts for the hero locker's reaction to a real launch. The rules themselves (our own images only, no
 * look-alikes, what counts as news) are tested in lib/launchpad/hero-coin.test.ts; these keep the wiring honest:
 * the poll is the clock, no token name is ever drawn, and the coin's picture ends invisible on its own.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const locker = read("./HeroLocker.tsx");
const machine = read("./LaunchMachine.tsx");
const css = read("./LaunchMachine.module.css");

test("the wrapper reads the shared poll and draws a chain, never a token name", () => {
  assert.doesNotMatch(locker, /setTimeout|setInterval|requestAnimationFrame|\bfetch\s*\(/, "no clock or request of its own");
  assert.match(locker, /const \{ live, subscribe \} = useLive\(\);/);
  assert.match(locker, /const picked = pickLaunch\(data\.feed, seen\.current \?\? new Set\(\), data\.at, imageBase\);/);
  assert.match(locker, /const active = coinActive\(reaction, live\.at\);/, "its clock is the poll's");
  // what reaches the drawing is a vetted picture and a chain's full name: nothing about the token's name or symbol
  assert.doesNotMatch(locker, /\.name\b|\.symbol\b|image_url/);
  assert.match(locker, /eyebrow=\{active \? `New launch on \$\{CHAIN_LABELS\[reaction\.chain\]\}` : undefined\}/);
  assert.match(locker, /coin=\{active && reaction\.src \? \{ key: reaction\.key, src: reaction\.src \} : null\}/);
});

test("the launches the page was drawn with never react, and a poll that replaces a reaction keeps the newest", () => {
  assert.match(locker, /seen\.current = new Set\(live\.feed\.filter\(\(item\) => item\.kind === "launch"\)\.map\(feedKey\)\);/);
  assert.match(locker, /setReaction\(\(cur\) => picked\.reaction \?\? \(cur && data\.at - cur\.since >= COIN_LIFE_MS \? null : cur\)\);/);
});

test("the machine draws the picture upright and foreshortened to the coin's ring, keyed per launch, with a unique clip", () => {
  assert.match(machine, /coin = null, eyebrow \}: \{ coin\?: \{ key: string; src: string \} \| null; eyebrow\?: string \}/);
  assert.match(machine, /const clip = `coin-clip-\$\{useId\(\)\.replace\(\/:\/g, ""\)\}`;/, "colons are not valid in a url(#id)");
  assert.match(machine, /<g transform="translate\(280 88\) scale\(1 \.4186\)">\s*<g key=\{coin\.key\} className=\{styles\.coinFace\}>/, "43 x 18 is the coin's inner ring: .4186 is 18/43");
  assert.match(machine, /<clipPath id=\{clip\}><circle r=\{43\} \/><\/clipPath>/);
  assert.match(machine, /<image href=\{coin\.src\} x=\{-43\} y=\{-43\} width=\{86\} height=\{86\} preserveAspectRatio="xMidYMid slice" clipPath=\{`url\(#\$\{clip\}\)`\} \/>/);
  assert.match(machine, /\{eyebrow \?\? "One transaction\. Built to stay\."\}/, "without a host the caption is the one /rules shows");
  assert.doesNotMatch(machine, /setTimeout|setInterval|\bfetch\s*\(|canvas/i);
});

test("the picture ends invisible on its own, exactly when the code says it is done, and reduced motion does not move it", () => {
  const face = css.split("\n").find((line) => line.startsWith(".coinFace {")) ?? "";
  const out = /coin-out 700ms ease-in ([\d.]+)s forwards/.exec(face);
  assert.ok(out, "a fade-out that fills forwards");
  assert.equal(Math.round((Number(out[1]) + 0.7) * 1000), COIN_LIFE_MS, "the last frame is at the end of the coin's life");
  assert.match(css, /@keyframes coin-out \{ to \{ opacity: 0; \} \}/);
  const still = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) { .coinFace"));
  assert.match(still, /\.coinFace \{ animation: coin-fade 300ms ease-out backwards, coin-out 700ms ease-in 14\.3s forwards; \}/);
  assert.doesNotMatch(css.slice(css.indexOf("@keyframes coin-fade")), /^@keyframes coin-fade \{[^}]*(transform|scale)/, "a fade, not a move");
});
