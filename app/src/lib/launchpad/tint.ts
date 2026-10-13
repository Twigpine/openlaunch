/**
 * A token's quiet accent, taken from its logo: the hue the logo is mostly made of, tuned per theme so a ring or a
 * chart line clears 3:1 against the page (WCAG 1.4.11 for graphics). Never used for text or actions; blue stays
 * the only action colour. Pure: the pixels come from tintServer.ts, so this runs in tests without an image.
 */
export type TokenTint = { hue: number; light: string; dark: string };
type Rgb = readonly [number, number, number];

const PAPER: Record<"light" | "dark", Rgb> = { light: [250, 250, 248], dark: [0, 0, 0] };
export const TINT_MIN_CONTRAST = 3;
/** A logo needs at least this share of colourful pixels to lend its hue; a black-and-white mark stays neutral. */
const MIN_COLOURFUL_SHARE = 0.06;

/** Deterministic hue from an address: the same seed the fallback avatar gradient uses. */
export function addressHue(addr: string): number {
  let h = 0;
  for (let i = 2; i < Math.min(addr.length, 18); i++) h = (h * 31 + addr.charCodeAt(i)) % 360;
  return h;
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The hue most of a logo's colourful pixels share, weighted by chroma, or null when the logo is essentially grey,
 * black or white. Transparent pixels (alpha under half) are ignored.
 */
export function dominantHue(pixels: ArrayLike<number>, channels: 3 | 4): { hue: number; sat: number } | null {
  const BINS = 36;
  const weight = new Float64Array(BINS);
  const x = new Float64Array(BINS);
  const y = new Float64Array(BINS);
  const sat = new Float64Array(BINS);
  let opaque = 0;
  let colourful = 0;
  for (let i = 0; i + channels - 1 < pixels.length; i += channels) {
    if (channels === 4 && pixels[i + 3] < 128) continue;
    opaque++;
    const r = pixels[i] / 255, g = pixels[i + 1] / 255, b = pixels[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const chroma = max - min;
    const l = (max + min) / 2;
    const s = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * l - 1));
    if (chroma < 0.08 || s < 0.2 || l < 0.1 || l > 0.94) continue;
    colourful++;
    let h = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
    h = (h * 60 + 360) % 360;
    const bin = Math.floor(h / (360 / BINS)) % BINS;
    weight[bin] += chroma;
    x[bin] += Math.cos((h * Math.PI) / 180) * chroma;
    y[bin] += Math.sin((h * Math.PI) / 180) * chroma;
    sat[bin] += s * chroma;
  }
  if (!opaque || colourful / opaque < MIN_COLOURFUL_SHARE) return null;
  // the strongest neighbourhood of three bins, so a hue split across a bin edge still wins
  let best = 0;
  let bestWeight = -1;
  for (let i = 0; i < BINS; i++) {
    const w = weight[(i + BINS - 1) % BINS] + weight[i] + weight[(i + 1) % BINS];
    if (w > bestWeight) { bestWeight = w; best = i; }
  }
  let sx = 0, sy = 0, ss = 0, sw = 0;
  for (const i of [(best + BINS - 1) % BINS, best, (best + 1) % BINS]) { sx += x[i]; sy += y[i]; ss += sat[i]; sw += weight[i]; }
  const hue = Math.round(((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360) % 360;
  return { hue, sat: ss / sw };
}

/**
 * Theme colours for a hue: as vivid as the logo allows (within a calm band), darkened for the light theme and
 * lightened for the dark one until each clears 3:1 against its page.
 */
export function tintFor(hue: number, saturation: number): TokenTint {
  const s = Math.min(0.85, Math.max(0.45, saturation));
  let light = hslToRgb(hue, s, 0.46);
  for (let l = 0.46; l >= 0.12 && contrastRatio(light, PAPER.light) < TINT_MIN_CONTRAST; l -= 0.01) light = hslToRgb(hue, s, l);
  let dark = hslToRgb(hue, s, 0.6);
  for (let l = 0.6; l <= 0.9 && contrastRatio(dark, PAPER.dark) < TINT_MIN_CONTRAST; l += 0.01) dark = hslToRgb(hue, s, l);
  return { hue, light: toHex(light), dark: toHex(dark) };
}

/** A token with no logo takes its avatar's hue, so the page matches the generated mark. */
export function fallbackTint(token: string): TokenTint {
  return tintFor(addressHue(token), 0.7);
}

/** A black-and-white logo lends no colour: the page keeps the theme's own muted grey (hue -1). */
export function neutralTint(): TokenTint {
  return { hue: -1, light: "#64748b", dark: "#8c8c8c" };
}

/** The tint for a logo's pixels: its dominant hue, or neutral when it has none. */
export function tintFromPixels(pixels: ArrayLike<number>, channels: 3 | 4): TokenTint {
  const found = dominantHue(pixels, channels);
  return found ? tintFor(found.hue, found.sat) : neutralTint();
}
