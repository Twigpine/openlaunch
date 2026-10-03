import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source-contract checks, not a browser interaction suite. These protect the
 * hero's product facts, shared-data boundary and motion fallbacks while leaving
 * its geometry and layout free to evolve. Browser QA still covers actual focus,
 * hydration, animation timing and both responsive themes.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const machine = read("./LaunchMachine.tsx");
// Git may check CSS out with CRLF on Windows; the animation contract is identical.
const css = read("./LaunchMachine.module.css").replace(/\r\n/g, "\n");
const metrics = read("./LaunchMechanism.tsx");
const hero = read("./LaunchHero.tsx");
const sequence = read("./LaunchSequence.tsx");

test("hero separates the permanent position lock from circulating token supply", () => {
  assert.match(hero, /liquidity position locked forever/i);
  assert.match(hero, /100% of the supply goes into the pool at launch/i);
  assert.match(machine, /liquidity position stays in an ownerless locker forever/i);
  assert.match(machine, /Tokens remain tradeable/);
  assert.doesNotMatch(hero + machine, /100% of (?:the )?supply[, ]+forever|supply locked forever/i);
});

test("hero metrics preserve shared live totals without inventing per-chain dollar sums", () => {
  assert.match(metrics, /useLive\(\)/);
  for (const field of ["launches", "volume_usd", "fees_to_creators_usd", "fees_burned_usd", "trades", "gitlawb_burned", "usd_partial"]) {
    assert.ok(metrics.includes(`t.${field}`), `missing live total: ${field}`);
  }
  // one launch count per chain, driven by the chain list so a new chain shows up without editing the hero
  // null-safe: during a rolling deploy a poll can come from a machine that predates a chain, so its bucket may be missing
  assert.match(metrics, /CHAIN_KEYS\.map\(\(k\) => [^\n]*t\.by_chain\[k\]\?\.launches \?\? 0/, "missing per-chain launch counts");
  // while any quote is unpriced the three dollar figures say "≈" with a tooltip instead of a confident undercount
  assert.match(metrics, /t\.usd_partial \? "≈" : ""/);
  for (const field of ["volume_usd", "fees_to_creators_usd", "fees_burned_usd"]) assert.ok(metrics.includes(`usd(t.${field}`), `${field} not routed through the ≈ guard`);
  assert.match(metrics, /no USD price right now/);
  // the GITLAWB burn: a GITLAWB amount (compact, exact in the title), never a USD figure, no per-chain split, behind the breakdown toggle
  assert.match(metrics, /fmtQuote\(t\.gitlawb_burned, GITLAWB_DECIMALS, GITLAWB_SYMBOL\)/);
  assert.match(metrics, /title=\{gitlawbBurnedExact\}/);
  assert.match(metrics, /fmtUnitsExact\(t\.gitlawb_burned, GITLAWB_DECIMALS\)/, "the title carries every digit of the raw amount (no float, no rounding)");
  assert.doesNotMatch(metrics, /fmtUsd\([^)]*gitlawb/i, "the GITLAWB burn is never priced in USD");
  assert.doesNotMatch(metrics, /by_chain\.\w+\.gitlawb_burned/, "no per-chain split for the GITLAWB burn");
  const details = metrics.indexOf("<details");
  assert.ok(details >= 0 && metrics.indexOf(">GITLAWB burned<") > details, "the GITLAWB burn stays behind the breakdown toggle");
  assert.match(metrics, /All-time volume/);
  assert.match(metrics, /Fees to recipients/);
  assert.doesNotMatch(metrics, /volume_quote_eth|volume_quote_usdg|\bfetch\s*\(|\bsetInterval\s*\(/);
  assert.doesNotMatch(metrics, /\bTVL\b|creator profit|paid out/i);
});

test("launch machine keeps proof links and the header CTA handoff contract", () => {
  assert.match(hero, /id="hero-cta"/);
  assert.match(metrics, /BRAND_GITHUB[\s\S]*contracts\/src/);
  // a locker proof link for every configured chain
  assert.match(machine, /CHAIN_KEYS\.flatMap\(\(k\) => \{ const locker = launchpad\(k\)\.locker;/);
  assert.match(machine, /explorerAddress\(chain, locker\)/);
});

test("decorative geometry has readable keyboard-operable mechanism controls", () => {
  assert.match(machine, /<svg\b[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(machine, /role="group" aria-label="Explore the launch mechanism"/);
  assert.match(machine, /<button\b[^>]*type="button"[^>]*aria-pressed=/);
  assert.match(machine, /aria-controls="launch-stage-detail"/);
  assert.match(machine, /id="launch-stage-detail"/);
  assert.doesNotMatch(metrics, /aria-live=/, "the five-second totals poll should not repeatedly announce the whole hero");
});

test("hero autoplay loops on CSS clocks with a user pause and cleaned-up observers", () => {
  assert.match(css, /animation: token-cycle[^;]+infinite/);
  assert.match(css, /animation-play-state: var\(--motion-state\)/);
  assert.match(machine, /Pause launch animation/);
  assert.match(machine, /Play launch animation/);
  assert.doesNotMatch(machine, /\bsetInterval\s*\(|\bsetTimeout\s*\(|<canvas\b|\bfetch\s*\(/);
  assert.match(machine, /observer\.disconnect\(\)/);
  assert.match(machine, /removeEventListener\("change",/);
  assert.match(machine, /removeEventListener\("visibilitychange",/);
  assert.match(machine, /document\.hidden/);
});

test("autoplay includes mobile while reduced motion and manual inspection remain still", () => {
  assert.match(machine, /const MOTION_QUERY = "\(prefers-reduced-motion: no-preference\)"/);
  assert.match(machine, /event\.pointerType !== "mouse"/);
  assert.match(machine, /if \(!playing \|\| event\.pointerType/);
  assert.match(machine, /setInspecting\(true\)/);
  assert.match(machine, /disabled=\{!motionAllowed\}/);
  const fallback = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(fallback, /transition:\s*none/);
  assert.match(fallback, /transform:\s*none\s*!important/);
  assert.match(fallback, /animation:\s*none/);
  assert.doesNotMatch(fallback, /\.playback\s*\{\s*display:\s*none/);
});

test("curved hero caption shares the existing stage and pausable motion contract", () => {
  assert.match(machine, /<LaunchSequence stage=\{stage\} \/>/);
  assert.match(sequence, /useId\(\)/);
  assert.match(sequence, /data-active=\{stage === index\}/);
  assert.match(sequence, /<textPath href=\{`#\$\{pathId\}`\}/);
  for (const label of ["Create", "Pool", "Lock"]) assert.ok(sequence.includes(`label: "${label}"`));
  assert.doesNotMatch(sequence, /\buseEffect\b|\buseState\b|\bsetInterval\b|\bsetTimeout\b|\brequestAnimationFrame\b|gsap|motion\/react/);
  assert.match(css, /\.sequenceLabel \{ animation: sequence-reveal[^}]+animation-play-state: var\(--motion-state\)/);
  assert.match(css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)")), /\.sequenceLabel \{ animation: none; \}/);
  assert.match(css, /aspect-ratio: 560 \/ 398/, "the new caption stays inside the reserved illustration footprint");
  assert.doesNotMatch(hero, /["']use client["']/, "the promise and CTA stay server rendered");
});

test("step selection and copy follow CSS phase events, including the loop seam", () => {
  assert.match(machine, /onAnimationStart=\{\(\) => \{ if \(looping\) setStage\(index\); \}\}/);
  assert.match(machine, /onAnimationIteration=\{\(\) => \{ if \(looping\) setStage\(index\); \}\}/);
  assert.match(machine, /aria-pressed=\{stage === index\}/);
  assert.match(machine, /className=\{styles.detailContent\} aria-hidden=\{stage !== index\}/);
  assert.match(machine, /\{item.title\}/);
  assert.match(machine, /\{item.description\}/);
  assert.match(css, /\.detailContent \{ grid-area: 1 \/ 1; \}/);
  assert.match(css, /\.detailContent\[aria-hidden="true"\] \{ visibility: hidden; \}/);
  assert.match(machine, /id="launch-stage-detail"[^>]*aria-live="off"/);
  assert.doesNotMatch(machine, /\.focus\(/, "autoplay must not move keyboard focus");
  for (const [phase, name, delay, duration] of [[0, "token", "-.11", "35"], [1, "pool", ".24", "25"], [2, "lock", ".49", "40"]] as const) {
    assert.ok(css.includes(`.stageProgress[data-phase="${phase}"] { animation: ${name}-progress var(--cycle) linear calc(var(--cycle) * ${delay}) infinite; }`));
    assert.ok(css.includes(`@keyframes ${name}-progress {\n  0% { transform: scaleX(0); opacity: 1; }\n  ${duration}% { transform: scaleX(1); opacity: 1; }`));
  }
  assert.match(css, /\.stageProgress\[data-phase\] \{ animation-play-state: var\(--motion-state\); \}/);
  assert.match(css, /:is\(\.stageProgress\[data-phase\], \.detailContent\[aria-hidden\]\) \{ animation: none; \}/);
});
