/**
 * Server-side re-encode of an uploaded logo (sharp). Nothing user-supplied is ever stored as-is:
 * the decoder is the real validator, output is always a square WebP with metadata stripped.
 * No "@/" imports so node --test can load it.
 */
import sharp from "sharp";
import { BANNER_HEIGHT, BANNER_WIDTH, IMAGE_SIZE } from "./images.ts";

export const MAX_INPUT_PIXELS = 30_000_000; // 30 MP decode ceiling (decompression-bomb guard)

export async function toLogoWebp(input: Uint8Array): Promise<Buffer> {
  const img = sharp(Buffer.from(input), { animated: false, limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
  const meta = await img.metadata();
  if (!meta.width || !meta.height || meta.width < 16 || meta.height < 16) throw new Error("image too small (min 16×16)");
  return img
    .rotate() // honour EXIF orientation before it is stripped
    .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "cover", position: "attention", withoutEnlargement: false })
    .flatten({ background: "#ffffff" }) // no alpha surprises on dark/light cards
    .webp({ quality: 84, effort: 4 })
    .toBuffer(); // sharp drops EXIF/ICC/XMP unless withMetadata() is called
}

/** The same treatment for a banner: decoded, cropped to BANNER_WIDTH×BANNER_HEIGHT around the subject, re-encoded. */
export async function toBannerWebp(input: Uint8Array): Promise<Buffer> {
  const img = sharp(Buffer.from(input), { animated: false, limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
  const meta = await img.metadata();
  if (!meta.width || !meta.height || meta.width < 300 || meta.height < 100) throw new Error("banner too small (min 300×100)");
  return img
    .rotate()
    .resize(BANNER_WIDTH, BANNER_HEIGHT, { fit: "cover", position: "attention", withoutEnlargement: false })
    .flatten({ background: "#ffffff" })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
}

/** Cheap post-check used by tests and the route: output really is a WebP of the expected size. */
export async function describeWebp(buf: Uint8Array): Promise<{ format: string | undefined; width: number | undefined; height: number | undefined; hasExif: boolean }> {
  const m = await sharp(Buffer.from(buf)).metadata();
  return { format: m.format, width: m.width, height: m.height, hasExif: Boolean(m.exif) };
}
