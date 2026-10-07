/**
 * Pure token-image rules (node --test loads this directly; no "@/" imports).
 * Uploads are sniffed by magic bytes, never by extension or declared type,
 * then re-encoded server-side (imageProcess.ts) so nothing user-supplied is stored as-is.
 */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024; // request body cap
export const IMAGE_SIZE = 512; // stored logo is IMAGE_SIZE×IMAGE_SIZE WebP
/** A banner is wide (3:1, the shape of a profile header) and allowed a larger upload. */
export const BANNER_WIDTH = 1500;
export const BANNER_HEIGHT = 500;
export const BANNER_MAX_BYTES = 4 * 1024 * 1024;

/** What an upload is for: the square logo, or the wide banner. Anything else is a logo, the original upload. */
export type ImageRole = "logo" | "banner";
export function imageRole(v: unknown): ImageRole {
  return v === "banner" ? "banner" : "logo";
}
export function maxBytesFor(role: ImageRole): number {
  return role === "banner" ? BANNER_MAX_BYTES : IMAGE_MAX_BYTES;
}
export const IMAGE_UPLOADS_PER_HOUR = 10; // per wallet and per IP
export const IMAGE_KEY_BYTES = 24;

export type ImageKind = "png" | "jpeg" | "webp" | "gif";
export const IMAGE_KINDS: readonly ImageKind[] = ["png", "jpeg", "webp", "gif"];

/** Magic-byte sniff. SVG, HTML, BMP, TIFF, AVIF, etc. → null (rejected). */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
  return null;
}

/** Upload pre-checks that need no decoder: size window + magic bytes. */
export function checkUpload(bytes: Uint8Array, maxBytes = IMAGE_MAX_BYTES): { ok: true; kind: ImageKind } | { ok: false; status: 413 | 415; error: string } {
  if (bytes.length > maxBytes) return { ok: false, status: 413, error: `image must be ≤ ${maxBytes / 1024 / 1024} MB` };
  const kind = sniffImage(bytes);
  if (!kind) return { ok: false, status: 415, error: "PNG, JPEG, WebP or GIF only" };
  return { ok: true, kind };
}

/** Object key from random bytes: unguessable, never derived from user input, always .webp. */
export function imageKey(rand: Uint8Array): string {
  if (rand.length < IMAGE_KEY_BYTES) throw new Error("need more entropy");
  let hex = "";
  for (let i = 0; i < IMAGE_KEY_BYTES; i++) hex += rand[i].toString(16).padStart(2, "0");
  return `t/${hex}.webp`;
}

export function randomImageKey(): string {
  const rand = new Uint8Array(IMAGE_KEY_BYTES);
  crypto.getRandomValues(rand);
  return imageKey(rand);
}

/** The key of a picture in our store (`t/<48 hex>.webp`) inside any URL that points at it (any host, a query or fragment after it), else null. */
export function pictureKey(url: string | null | undefined): string | null {
  const m = url ? /\/(t\/[0-9a-f]{48}\.webp)(?=$|[?#])/i.exec(url) : null;
  return m ? m[1].toLowerCase() : null;
}

/** A launch's registered metadata, as far as ownership of its picture goes. */
export type PictureUse = { chain_id: number; token: string; created_at: Date | string; image_url: string | null };

/**
 * `chain_id:token` of each of `rows` whose picture another token registered first. A picture belongs to the first token that
 * registered it (the creator registers before broadcasting, and the key is random and secret until then): the same key on a
 * later token is a copy of somebody else's picture, however it got there. Ties go to the lower address, so the answer never
 * depends on read order. `all` holds every registration of the pictures `rows` use.
 */
export function reusedPictures(rows: readonly Pick<PictureUse, "chain_id" | "token" | "image_url">[], all: readonly PictureUse[]): Set<string> {
  const first = new Map<string, { at: number; id: string }>();
  for (const use of all) {
    const key = pictureKey(use.image_url);
    if (!key) continue;
    const at = new Date(use.created_at).getTime();
    const mine = { at: Number.isFinite(at) ? at : Infinity, id: `${use.chain_id}:${use.token.toLowerCase()}` };
    const best = first.get(key);
    if (!best || mine.at < best.at || (mine.at === best.at && mine.id < best.id)) first.set(key, mine);
  }
  const reused = new Set<string>();
  for (const row of rows) {
    const key = pictureKey(row.image_url);
    const id = `${row.chain_id}:${row.token.toLowerCase()}`;
    const owner = key ? first.get(key) : undefined;
    if (owner && owner.id !== id) reused.add(id);
  }
  return reused;
}

/** Public URL for a stored key under the bucket's public base (no trailing slash). */
export function imageUrlFor(publicBase: string, key: string): string {
  return `${publicBase.replace(/\/+$/, "")}/${key}`;
}

/**
 * True only for https URLs on OUR image host with a key of the shape we mint.
 * Used to decide whether a server-side fetch (OG card) is allowed — every other host stays blocked.
 */
export function isOwnImageUrl(url: string | null | undefined, publicBase: string | null): boolean {
  if (!url || !publicBase) return false;
  let u: URL, b: URL;
  try {
    u = new URL(url);
    b = new URL(publicBase);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.hostname !== b.hostname || u.port !== b.port) return false;
  if (u.username || u.password || u.search || u.hash) return false;
  const prefix = b.pathname.replace(/\/+$/, "");
  const rel = u.pathname.startsWith(prefix + "/") ? u.pathname.slice(prefix.length + 1) : null;
  return rel !== null && new RegExp(`^t/[0-9a-f]{${IMAGE_KEY_BYTES * 2}}\\.webp$`).test(rel);
}

/** Validate a client-declared wallet before it's used as a rate-limit key. */
export function isWalletParam(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/** The store key (`t/<hex>.webp`) a logo URL points at, whatever host it names; null for any other URL. */
export function storedImageKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const m = new URL(url).pathname.match(new RegExp(`/(t/[0-9a-f]{${IMAGE_KEY_BYTES * 2}}\\.webp)$`));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Hosts we handed out before switching to same-origin URLs (objects there are not publicly readable). */
export const LEGACY_IMAGE_HOSTS = ["openlaunch-images.fly.storage.tigris.dev", "fly.storage.tigris.dev"];

/**
 * Rewrite a stored image URL to the canonical same-origin form when it points at a legacy bucket host
 * with one of our keys; every other URL is returned untouched.
 */
export function canonicalImageUrl(url: string | null | undefined, publicBase: string | null): string | null {
  if (!url) return null;
  if (!publicBase) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== "https:" || !LEGACY_IMAGE_HOSTS.includes(u.hostname)) return url;
  const m = u.pathname.match(new RegExp(`/(t/[0-9a-f]{${IMAGE_KEY_BYTES * 2}}\\.webp)$`));
  return m ? imageUrlFor(publicBase, m[1]) : url;
}
