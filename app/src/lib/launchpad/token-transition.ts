/**
 * Identity for the market-row → token-page morph.
 *
 * Both ends render the token's mark and name inside a React <ViewTransition> with the same name, so
 * the browser animates one object moving instead of a page swap. The token route has a loading
 * boundary, so the first frame after a click is the loading screen, which knows nothing about the
 * token yet. The row therefore leaves a short-lived note of what was tapped; the loading header reads
 * it and renders the same mark and name, which lets the morph pair form on that first frame.
 */

export type PendingToken = { chain: string; token: string; name: string; symbol: string; image: string | null };

/** View-transition names must be unique on a page and valid CSS identifiers. */
export function tokenMorphNames(chain: string, token: string): { avatar: string; name: string } {
  const id = `${chain}-${token.toLowerCase()}`.replace(/[^a-z0-9-]/g, "");
  return { avatar: `tok-av-${id}`, name: `tok-nm-${id}` };
}

const TOKEN_PATH = /^\/t\/([a-z]+)\/(0x[0-9a-f]{40})(?:\/|$)/i;

/** The chain and token a /t/<chain>/<token> path points at, or null for any other route. */
export function matchTokenPath(pathname: string | null | undefined): { chain: string; token: string } | null {
  const m = TOKEN_PATH.exec(pathname ?? "");
  return m ? { chain: m[1].toLowerCase(), token: m[2].toLowerCase() } : null;
}

let pending: PendingToken | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Remember the token a visitor just opened. The note expires on its own, so a stale one never leaks into a later visit. */
export function setPendingToken(token: PendingToken, ttlMs = 15_000): void {
  pending = { ...token, chain: token.chain.toLowerCase(), token: token.token.toLowerCase() };
  if (expiry) clearTimeout(expiry);
  expiry = setTimeout(clearPendingToken, ttlMs);
  (expiry as { unref?: () => void }).unref?.();
  emit();
}

export function clearPendingToken(): void {
  if (expiry) clearTimeout(expiry);
  expiry = null;
  if (pending === null) return;
  pending = null;
  emit();
}

export function getPendingToken(): PendingToken | null {
  return pending;
}

/** The note only counts on the route it was left for. */
export function pendingTokenFor(pathname: string | null | undefined, note: PendingToken | null = pending): PendingToken | null {
  const target = matchTokenPath(pathname);
  if (!target || !note) return null;
  return note.chain === target.chain && note.token === target.token ? note : null;
}

export function subscribePendingToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
