/**
 * Pure helper for the route/global error boundaries (node --test loads this;
 * the .tsx pages stay thin). Their words live in the messages (info.errors).
 *
 * Next.js App Router injects `{ error, reset }` into `error.tsx` and
 * `global-error.tsx` — never a `retry` prop. `sanitizeDigest` keeps the
 * optional `error.digest` display safe: only short opaque ids render,
 * everything else is dropped so creator-adjacent strings can never break
 * out of the error paragraph.
 */

const DIGEST_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Keep only short opaque digest ids; drop anything that looks like markup. */
export function sanitizeDigest(digest: unknown): string | null {
  if (typeof digest !== "string") return null;
  const d = digest.trim();
  if (d.length === 0 || d.length > 64) return null;
  return DIGEST_RE.test(d) ? d : null;
}
