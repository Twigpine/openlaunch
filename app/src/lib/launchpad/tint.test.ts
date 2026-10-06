import { test } from "node:test";
import assert from "node:assert/strict";
import { TINT_MIN_CONTRAST, addressHue, contrastRatio, dominantHue, fallbackTint, hslToRgb, tintFor, toHex } from "./tint.ts";

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
/** An image as raw RGBA: `n` pixels of each colour. */
function image(...parts: [number, number, number, number, number][]): Uint8Array {
  const out: number[] = [];
  for (const [r, g, b, a, n] of parts) for (let i = 0; i < n; i++) out.push(r, g, b, a);
  return Uint8Array.from(out);
}

test("hsl converts to the expected rgb at the primaries", () => {
  assert.deepEqual(hslToRgb(0, 1, 0.5), [255, 0, 0]);
  assert.deepEqual(hslToRgb(120, 1, 0.5), [0, 255, 0]);
  assert.deepEqual(hslToRgb(240, 1, 0.5), [0, 0, 255]);
  assert.equal(toHex([255, 128, 0]), "#ff8000");
});

test("every hue clears 3:1 against both pages", () => {
  for (let hue = 0; hue < 360; hue += 5) {
    for (const sat of [0.2, 0.6, 1]) {
      const t = tintFor(hue, sat);
      assert.ok(contrastRatio(rgb(t.light), [250, 250, 248]) >= TINT_MIN_CONTRAST, `light ${hue}/${sat} ${t.light}`);
      assert.ok(contrastRatio(rgb(t.dark), [0, 0, 0]) >= TINT_MIN_CONTRAST, `dark ${hue}/${sat} ${t.dark}`);
    }
  }
});

test("a logo lends the hue most of its colourful pixels share", () => {
  // mostly orange with a white background and a little blue
  const px = image([255, 255, 255, 255, 600], [245, 130, 20, 255, 300], [30, 60, 220, 255, 60]);
  const hue = dominantHue(px, 4);
  assert.ok(hue);
  assert.ok(Math.abs(hue.hue - 29) <= 4, `got ${hue.hue}`);
});

test("transparent pixels never vote", () => {
  const px = image([255, 0, 0, 0, 900], [20, 180, 60, 255, 100]);
  assert.ok(Math.abs(dominantHue(px, 4)!.hue - 137) <= 4);
});

test("a black-and-white or grey logo stays neutral", () => {
  assert.equal(dominantHue(image([0, 0, 0, 255, 500], [255, 255, 255, 255, 500]), 4), null);
  assert.equal(dominantHue(image([120, 122, 125, 255, 1000]), 4), null);
  // a speck of colour under the threshold does not count
  assert.equal(dominantHue(image([255, 255, 255, 255, 970], [255, 0, 0, 255, 30]), 4), null);
  assert.equal(dominantHue(new Uint8Array(0), 4), null);
});

test("a hue split across a bin edge still wins as one colour", () => {
  // 9° and 11° sit in neighbouring 10° bins; together they outweigh a single purple bin
  const px = image([255, 41, 0, 255, 200], [255, 47, 0, 255, 200], [140, 0, 255, 255, 300]);
  const hue = dominantHue(px, 4)!.hue;
  assert.ok(hue >= 8 && hue <= 12, `got ${hue}`);
});

test("rgb input without alpha reads the same", () => {
  const px = Uint8Array.from([10, 200, 90, 10, 200, 90, 10, 200, 90]);
  assert.ok(Math.abs(dominantHue(px, 3)!.hue - 147) <= 4);
});

test("a token without a logo takes its fallback avatar's hue", () => {
  const token = "0x648a5382bdcf286e7ff5122d01a983db314e620a";
  assert.equal(fallbackTint(token).hue, addressHue(token));
  assert.ok(addressHue(token) >= 0 && addressHue(token) < 360);
  assert.notEqual(addressHue(token), addressHue("0x5b3c2cd87083ea5c4436525dca6213740405b69e"), "different tokens, different hues");
});
