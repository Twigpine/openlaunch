import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contracts for pausing ambient motion off screen. The page keeps dozens of animations running for ever (a beacon on every
 * live row, floating bubbles, pings), which a slow phone pays for whether or not anyone can see them. Browser QA counts what runs
 * where; these keep the pause attached to the right containers and away from the one that is a clock.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const hook = read("./usePauseOffscreen.ts");
const globals = read("../../app/globals.css");

test("the hook marks a container while it is far off screen, with no timer and no state", () => {
  assert.match(hook, /new IntersectionObserver\(\(\[entry\]\) => \{ el\.dataset\.offscreen = entry\.isIntersecting \? "false" : "true"; \}, \{ rootMargin: "160px 0px" \}\);/);
  assert.doesNotMatch(hook, /setTimeout|setInterval|requestAnimationFrame|useState/, "no clock, and no re-render of the container");
  assert.match(hook, /export function usePauseOffscreen<T extends HTMLElement>\(enabled = true\)/);
  // turned off, or unmounted: the container is left running, never stuck paused
  assert.match(hook, /if \(!enabled\) \{\n\s*delete el\.dataset\.offscreen;\n\s*return;\n\s*\}/);
  assert.match(hook, /return \(\) => \{\n\s*watch\.disconnect\(\);\n\s*delete el\.dataset\.offscreen;\n\s*\};/);
});

test("the stylesheet pauses every animation inside a marked container, and only those", () => {
  assert.match(globals, /\[data-offscreen="true"\], \[data-offscreen="true"\] \*, \[data-offscreen="true"\] \*::before, \[data-offscreen="true"\] \*::after \{ animation-play-state: paused !important; \}/);
  assert.doesNotMatch(globals, /\*\s*\{[^}]*animation-play-state: paused/, "never everywhere");
});

test("the list, the side column and the live panel use it; the river's clock is left running", () => {
  const list = read("./LaunchList.tsx");
  assert.match(list, /import \{ usePauseOffscreen \} from "\.\/usePauseOffscreen";/);
  assert.match(list, /const section = usePauseOffscreen<HTMLElement>\(\);/);
  assert.match(list, /<section ref=\{section\} id="launches"/);
  const fresh = read("./JustLaunched.tsx");
  assert.match(fresh, /const section = usePauseOffscreen<HTMLElement>\(\);/);
  assert.match(fresh, /<section ref=\{section\} aria-labelledby="fresh-heading"/);
  const river = read("./LiveRiver.tsx");
  // the river's marks drift on a real-time clock (a negative delay places each at its true age): pausing it would make them lag
  assert.match(river, /const section = usePauseOffscreen<HTMLElement>\(view !== "river"\);/);
  assert.match(river, /<section ref=\{section\} aria-labelledby="river-heading"/);
});

test("the locker keeps its own visibility rule rather than this one", () => {
  const machine = read("./LaunchMachine.tsx");
  assert.match(machine, /new IntersectionObserver\(\(\[entry\]\) => \{\n\s*setInView\(entry\.isIntersecting && entry\.intersectionRatio >= 0\.15\);/);
  assert.doesNotMatch(machine, /usePauseOffscreen/);
});
