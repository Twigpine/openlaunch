/**
 * Presentation-only search over the recent posts already loaded by the feed: the post, its token, and its author by
 * address, username (with or without @) or display name. `nameOf` reads the names the feed already shows.
 */
type FeedSearchRow = { chain: string; body: string; token: string; wallet: string; symbol?: string; name?: string };
export type AuthorName = { u: string; d: string } | null | undefined;
export function filterCommunityPosts<T extends FeedSearchRow>(posts: T[], chain: string | null, query: string, nameOf: (wallet: string) => AuthorName = () => null): T[] {
  const q = query.trim().toLowerCase();
  const handle = q.replace(/^@/, "");
  return posts.filter((p) => {
    if (chain && p.chain !== chain) return false;
    if (!q) return true;
    if ([p.body, p.symbol, p.name, p.token, p.wallet].some((value) => value?.toLowerCase().includes(q))) return true;
    const author = nameOf(p.wallet);
    return Boolean(author && ((handle && author.u.toLowerCase().includes(handle)) || author.d.toLowerCase().includes(q)));
  });
}

/** Shared live snapshots contain 30 posts; compare that window without losing the server's full feed. */
export function communityFingerprint(posts: { id: number; body: string; tag: string | null; created_at: string }[]): string {
  return JSON.stringify(posts.slice(0, 30).map(({ id, body, tag, created_at }) => [id, body, tag, created_at]));
}
