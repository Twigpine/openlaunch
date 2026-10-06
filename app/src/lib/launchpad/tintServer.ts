import "server-only";
import sharp from "sharp";
import { readImage } from "./imageStore";
import { storedImageKey } from "./images";
import { fallbackTint, tintFromPixels, type TokenTint } from "./tint";

/**
 * A token page's tint, read from its stored logo. Only our own store is read (by key, never by fetching a URL),
 * the image is shrunk to 32×32 before counting, and results are cached per key: stored logos never change.
 * A logo the store cannot return right now falls back to the avatar hue for a minute, then is tried again.
 */
const SAMPLE = 32;
const MAX_CACHED = 2_000;
const RETRY_MS = 60_000;
const cache = new Map<string, { tint: TokenTint; until: number }>();

export async function tokenTint(image: string | null, token: string): Promise<TokenTint> {
  const key = storedImageKey(image);
  if (!key) return fallbackTint(token);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.tint;
  let tint: TokenTint | null = null;
  try {
    const bytes = await readImage(key);
    if (bytes) {
      const { data, info } = await sharp(bytes, { limitInputPixels: 4_096 * 4_096 }).resize(SAMPLE, SAMPLE, { fit: "cover" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      tint = tintFromPixels(data, info.channels === 3 ? 3 : 4);
    }
  } catch {
    tint = null;
  }
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  const result = tint ?? fallbackTint(token);
  cache.set(key, { tint: result, until: tint ? Infinity : Date.now() + RETRY_MS });
  return result;
}
