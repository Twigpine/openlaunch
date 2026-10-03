import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Lints the token layer in globals.css. It reads CSS text, so it proves the
 * palette is internally consistent — it cannot prove a component uses the right
 * token. A pass means "the ramp is sane", not "the UI is fine".
 *
 * Structure: the unclassed base (@theme) is LIGHT — the shipped "Clear Sky"
 * palette, which is also the default — and `.dark` overrides it behind the
 * header toggle. The toggler flips themes with a bare `classList.toggle("dark")`,
 * so "no class" must mean light.
 */
// Source contracts must behave the same with Git's LF and Windows CRLF checkouts.
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const themeBlock = css.match(/@theme(?:\s+static)?\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
const darkBlock = css.match(/\n\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
const printBlock = css.match(/@media print\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
const colors = (source: string) => Object.fromEntries(Array.from(source.matchAll(/--color-([\w-]+):\s*(#[\da-f]{3,8});/gi), ([, name, hex]) => [name, hex]));

const light = colors(themeBlock);
const dark = { ...light, ...colors(darkBlock) };
/** Light pairs are the pre-existing design: guard against regressions below their current worst case, never re-tune them here. */
const LIGHT_FLOOR = 3.0;
const THEMES: [string, Record<string, string>][] = [
  ["light", light],
  ["dark", dark],
];

/** WCAG relative luminance for opaque sRGB theme colors. */
function luminance(hex: string) {
  assert.match(hex, /^#[\da-f]{6}$/i, `expected a 6-digit hex, got ${hex}`);
  const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = rgb.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
const ratio = (fg: string, bg: string) => {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

test("dark: black ground, white ink", () => {
  assert.equal(dark.paper, "#000000");
  assert.equal(dark.ink, "#ffffff");
  assert.equal(dark.inverse, "#000000");
});

test("light is the original Clear Sky palette, unchanged, and the unclassed base", () => {
  // The shipped design. Adding dark mode must not move a single light value.
  assert.deepEqual(
    { paper: light.paper, card: light.card, line: light.line, "line-strong": light["line-strong"], ink: light.ink, body: light.body, muted: light.muted, faint: light.faint, brand: light.brand, "brand-strong": light["brand-strong"], "brand-soft": light["brand-soft"], up: light.up, "up-soft": light["up-soft"], down: light.down, "down-ink": light["down-ink"], "down-soft": light["down-soft"], warm: light.warm, "warm-ink": light["warm-ink"], "warm-soft": light["warm-soft"] },
    { paper: "#fafaf8", card: "#ffffff", line: "#e7e5e4", "line-strong": "#d6d3d1", ink: "#0f172a", body: "#475569", muted: "#64748b", faint: "#94a3b8", brand: "#0052ff", "brand-strong": "#0041cc", "brand-soft": "#eaf0ff", up: "#15803d", "up-soft": "#ecfdf3", down: "#dc2626", "down-ink": "#b91c1c", "down-soft": "#fef2f2", warm: "#d97706", "warm-ink": "#b45309", "warm-soft": "#fffbeb" },
  );
  // The animated toggler does classList.toggle("dark") and never writes a
  // `light` class — if light lived in its own class this would break.
  assert.equal(css.includes("\n.light {"), false, "light must not live in a class");
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light/);
  assert.match(darkBlock, /color-scheme:\s*dark/);
});

test("typography is unchanged", () => {
  assert.match(themeBlock, /--font-sans:\s*var\(--font-inter\)/);
  assert.match(themeBlock, /--font-mono:\s*var\(--font-geist-mono\)/);
  assert.match(themeBlock, /--font-display:\s*var\(--font-unbounded\)/);
});

test("the dark: variant resolves against a class, not a media query", () => {
  assert.match(css, /@custom-variant dark \(&:is\(\.dark \*\)\)/);
  assert.doesNotMatch(css, /@media \(prefers-color-scheme/, "theming is by explicit choice, never by OS preference");
});

test("dark greys are near-achromatic", () => {
  for (const [name, palette] of THEMES.filter(([n]) => n === "dark")) {
    for (const token of ["paper", "card", "line", "line-strong", "ink", "body", "muted", "faint"]) {
      const hex = palette[token];
      const [r, g, b] = [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16));
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      assert.ok(spread <= 8, `${name}: --color-${token} (${hex}) should be neutral, channel spread is ${spread}`);
    }
  }
});

test("the dark surface ramp steps away from the ground monotonically (light: white cards on off-white paper, by design)", () => {
  for (const [name, palette] of THEMES.filter(([n]) => n === "dark")) {
    const steps = ["paper", "card", "line", "line-strong"].map((n) => luminance(palette[n]));
    const rising = steps[1] > steps[0];
    for (let i = 1; i < steps.length; i++) {
      assert.equal(steps[i] > steps[i - 1], rising, `${name}: surface ramp reverses at index ${i}`);
    }
  }
});

test("dark text, semantic labels, and filled controls meet AA contrast (light is the shipped palette; it is checked for regressions, not re-tuned)", () => {
  const pairs = [
    ...["paper", "card"].flatMap((surface) => ["ink", "body", "muted", "brand", "up", "down-ink", "warm-ink"].map((text) => [text, surface])),
    ...["ink", "brand", "brand-strong", "up", "down", "warm-ink"].map((fill) => ["inverse", fill]),
    ["brand", "brand-soft"], ["up", "up-soft"], ["down-ink", "down-soft"], ["warm-ink", "warm-soft"], ["up", "holder-good-bg"],
  ];
  for (const [name, palette] of THEMES) {
    for (const [foreground, background] of pairs) {
      const r = ratio(palette[foreground], palette[background]);
      const floor = name === "dark" ? 4.5 : LIGHT_FLOOR;
      assert.ok(r >= floor, `${name}: ${foreground} on ${background} is ${r.toFixed(2)}:1`);
    }
  }
});

test("every base token has a dark counterpart", () => {
  const darkOnly = colors(darkBlock);
  const missing = Object.keys(light).filter((name) => !(name in darkOnly));
  assert.deepEqual(missing, [], `tokens with no dark value: ${missing.join(", ")}`);
});

test("the modal scrim darkens in both themes rather than inverting", () => {
  for (const [name, palette] of THEMES) {
    assert.ok(luminance(palette.scrim) < 0.05, `${name}: scrim must be dark`);
  }
});

test("the view-transition wipe is disabled under reduced motion", () => {
  // The toggler skips startViewTransition, and the pseudo-elements are pinned
  // too in case a transition is already in flight.
  assert.match(css, /::view-transition-new\(root\)/, "the wipe needs its own transition CSS");
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}\n/g)?.join("\n") ?? "";
  assert.match(reduced, /view-transition/, "reduced motion must also stop the theme wipe");
});

test("print falls back to ink on white", () => {
  const print = colors(printBlock);
  assert.equal(print.paper, "#ffffff", "black paper does not print");
  assert.equal(print.ink, light.ink);
});

test("runtime chart tokens survive Tailwind tree-shaking (@theme static) and exist in both themes", () => {
  assert.match(css, /@theme static\s*\{/);
  for (const t of ["chart-grid", "chart-vol"]) {
    assert.ok(t in light, `--color-${t} must be set in @theme`);
    assert.ok(t in colors(darkBlock), `--color-${t} must be set in .dark`);
  }
});
