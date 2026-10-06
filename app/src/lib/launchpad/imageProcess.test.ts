import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { describeWebp, toBannerWebp, toLogoWebp } from "./imageProcess.ts";
import { BANNER_HEIGHT, BANNER_WIDTH, IMAGE_SIZE, sniffImage } from "./images.ts";

async function fixture(format: "png" | "jpeg" | "webp" | "gif", w: number, h: number, extra?: (s: sharp.Sharp) => sharp.Sharp): Promise<Uint8Array> {
  let s = sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 82, b: 255, alpha: 1 } } });
  if (extra) s = extra(s);
  const buf = await s.toFormat(format).toBuffer();
  return new Uint8Array(buf);
}

test("re-encodes every accepted format to a 512×512 WebP", async () => {
  for (const f of ["png", "jpeg", "webp", "gif"] as const) {
    const input = await fixture(f, 300, 200);
    assert.equal(sniffImage(input), f, `fixture is a real ${f}`);
    const out = await toLogoWebp(input);
    const d = await describeWebp(out);
    assert.equal(d.format, "webp", f);
    assert.equal(d.width, IMAGE_SIZE, f);
    assert.equal(d.height, IMAGE_SIZE, f);
    assert.equal(sniffImage(new Uint8Array(out)), "webp");
  }
});

test("strips EXIF/metadata from the output", async () => {
  const input = await fixture("jpeg", 400, 400, (s) => s.withMetadata({ exif: { IFD0: { Copyright: "leak me", ImageDescription: "<script>alert(1)</script>" } } }));
  const inMeta = await sharp(Buffer.from(input)).metadata();
  assert.ok(inMeta.exif, "fixture carries EXIF");
  const out = await toLogoWebp(input);
  const d = await describeWebp(out);
  assert.equal(d.hasExif, false);
  assert.equal(Buffer.from(out).includes("leak me"), false);
  assert.equal(Buffer.from(out).includes("<script>"), false);
});

test("rejects garbage, disguised files, and tiny images", async () => {
  await assert.rejects(() => toLogoWebp(new TextEncoder().encode("definitely not an image".repeat(10))));
  // valid PNG magic bytes followed by junk: passes the sniff, must fail in the decoder
  const disguised = new Uint8Array(4096);
  disguised.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await assert.rejects(() => toLogoWebp(disguised));
  const tiny = await fixture("png", 8, 8);
  await assert.rejects(() => toLogoWebp(tiny), /too small/);
});

test("big inputs are cropped to a square, never enlarged blurrily beyond the logo size, and stay under 2 MB", async () => {
  const input = await fixture("png", 2400, 1200);
  const out = await toLogoWebp(input);
  const d = await describeWebp(out);
  assert.equal(d.width, IMAGE_SIZE);
  assert.equal(d.height, IMAGE_SIZE);
  assert.ok(out.length < 200_000, `output ${out.length}B is small`);
});

test("a banner is re-encoded to a 1500×500 WebP whatever its shape, and a tiny one is refused", async () => {
  for (const [w, h] of [[3000, 1000], [1200, 1200], [800, 200]]) {
    const out = await toBannerWebp(await fixture("png", w, h));
    const d = await describeWebp(out);
    assert.equal(d.format, "webp");
    assert.equal(d.width, BANNER_WIDTH);
    assert.equal(d.height, BANNER_HEIGHT);
    assert.equal(d.hasExif, false);
  }
  await assert.rejects(toBannerWebp(await fixture("png", 200, 80)), /too small/);
  await assert.rejects(toBannerWebp(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])));
});
