/** Presentation-only search over the recent posts already loaded by the feed. */
type FeedSearchRow = { chain: string; body: string; token: string; wallet: string; symbol?: string; name?: string };
export function filterCommunityPosts<T extends FeedSearchRow>(posts: T[], chain: string | null, query: string): T[] {
  const q = query.trim().toLowerCase();
  return posts.filter((p) => (!chain || p.chain === chain) && (!q || [p.body, p.symbol, p.name, p.token, p.wallet].some((value) => value?.toLowerCase().includes(q))));
}

/** Shared live snapshots contain 30 posts; compare that window without losing the server's full feed. */
export function communityFingerprint(posts: { id: number; body: string; tag: string | null; created_at: string; chain?: string; token?: string; wallet?: string; symbol?: string; name?: string; hidden?: boolean }[]): string {
  return JSON.stringify(posts.slice(0, 30).map(({ id, body, tag, created_at, chain, token, wallet, symbol, name, hidden }) => [id, body, tag, created_at, chain, token, wallet, symbol, name, hidden]));
}

export type CommunityWindow<T> = { visible: T[]; pending: T[] };

/**
 * Only call with the authoritative /feed response, never the 30-row live signal.
 * Delay additions, not moderation or edits. Both lists together remain within the
 * current 100-row server window, including when pending posts are later removed.
 */
export function reconcileCommunityWindow<T extends { id: number; hidden?: boolean }>(
  previous: CommunityWindow<T>, authoritative: T[], bufferAdditions: boolean,
): CommunityWindow<T> {
  const seen = new Set<number>();
  const current = authoritative.slice(0, 100).filter((post) => {
    if (post.hidden || seen.has(post.id)) return false;
    seen.add(post.id);
    return true;
  });
  if (!bufferAdditions) return { visible: current, pending: [] };
  const visibleIds = new Set(previous.visible.map((post) => post.id));
  return {
    visible: current.filter((post) => visibleIds.has(post.id)),
    pending: current.filter((post) => !visibleIds.has(post.id)),
  };
}

/** Reveal selected pending IDs without consuming other views' notifications. */
export function revealCommunityPosts<T extends { id: number; hidden?: boolean }>(
  previous: CommunityWindow<T>, authoritative: T[], postIds: readonly number[],
): CommunityWindow<T> {
  const selected = new Set(postIds);
  return reconcileCommunityWindow({
    visible: [...previous.visible, ...previous.pending.filter((post) => selected.has(post.id))],
    pending: previous.pending,
  }, authoritative, true);
}
