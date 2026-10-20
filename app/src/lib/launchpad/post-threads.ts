import type { PostRow } from "./postsServer";

/**
 * Token-page comment threading + composer helpers (pure; unit-tested).
 *
 * TokenComments rendered every reply list with `posts.filter(p => p.parent_id
 * === id)` per top-level post: O(n²) per render on a viral token. These
 * helpers build the reply map once (O(n)) and own client pagination + draft
 * persistence so the component stays thin.
 */

/** How many top-level comments render before "Show more". */
export const COMMENTS_PAGE = 20;

export function groupReplies(posts: PostRow[]): { top: PostRow[]; repliesById: Map<number, PostRow[]> } {
  const top: PostRow[] = [];
  const repliesById = new Map<number, PostRow[]>();
  for (const p of posts) {
    if (p.parent_id === null) top.push(p);
    else {
      const list = repliesById.get(p.parent_id);
      if (list) list.push(p);
      else repliesById.set(p.parent_id, [p]);
    }
  }
  // Newest reply last under each comment (server sends newest first).
  for (const list of repliesById.values()) list.reverse();
  return { top, repliesById };
}

export function visibleTopIds(top: PostRow[], shownCount: number): PostRow[] {
  return top.slice(0, Math.max(0, shownCount));
}

export function draftKey(chain: string, token: string): string {
  return `ol:comment-draft:${chain}:${token.toLowerCase()}`;
}

/** Composer draft: body plus the reply destination (null = top-level post). */
export type CommentDraft = { body: string; parentId: number | null };

function cleanParentId(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/** Load the full draft (body + reply target). Only the JSON shape is read; anything else is treated as no draft. */
export function loadCommentDraft(chain: string, token: string): CommentDraft {
  try {
    if (typeof localStorage === "undefined") return { body: "", parentId: null };
    const raw = localStorage.getItem(draftKey(chain, token));
    if (!raw) return { body: "", parentId: null };
    try {
      const parsed = JSON.parse(raw) as { body?: unknown; parentId?: unknown };
      if (parsed && typeof parsed === "object" && typeof parsed.body === "string") {
        if (!parsed.body) return { body: "", parentId: null };
        return { body: parsed.body, parentId: cleanParentId(parsed.parentId) };
      }
    } catch {
      /* not a draft we wrote: ignore */
    }
    return { body: "", parentId: null };
  } catch {
    return { body: "", parentId: null };
  }
}

export function saveDraft(chain: string, token: string, body: string, parentId: number | null = null): void {
  try {
    if (typeof localStorage === "undefined") return;
    // An empty body stores nothing: clicking Reply alone must not leave a
    // "Replying to #x" draft behind after a reload.
    if (!body) {
      localStorage.removeItem(draftKey(chain, token));
      return;
    }
    const pid = cleanParentId(parentId);
    localStorage.setItem(draftKey(chain, token), JSON.stringify({ body: body.slice(0, 2000), parentId: pid }));
  } catch {
    /* storage blocked: the in-memory textarea state is what survives */
  }
}

export function clearDraft(chain: string, token: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(draftKey(chain, token));
  } catch {
    /* ignore */
  }
}

/**
 * Resolve a restored reply target against the loaded posts.
 *
 * Draft restoration and the initial posts fetch race: posts starts empty, so
 * an empty list must not read as "parent missing" before the fetch, nor as
 * "parent exists" for signing. While !postsLoaded a non-null replyTo is
 * pending (caller blocks submit instead of signing an unvalidated parent).
 *
 * After loading the posts window is truncated (latest 100 rows). Absence in
 * that window is not authoritative evidence the parent was deleted/hidden, so
 * we preserve the saved destination and let the server reject it if truly gone.
 * No silent top-level fallback — the user keeps their intended reply target
 * unless we have checked it authoritatively.
 */
export function resolveReplyTarget(
  replyTo: number | null,
  postsLoaded: boolean,
): { target: number | null; pending: boolean } {
  if (replyTo === null) return { target: null, pending: false };
  if (!postsLoaded) return { target: replyTo, pending: true };
  // Window is truncated: missing from the latest 100 does not mean deleted.
  // Preserve the target; server will return 404 if truly gone and the UI will
  // surface that error instead of silently changing the destination.
  return { target: replyTo, pending: false };
}

/**
 * Stale-load guard for TokenComments.
 *
 * A fetch for token A resolving after the switch to token B must not touch
 * B's posts or postsLoaded. The component bumps a generation counter on every
 * token switch / cleanup and aborts the previous request; each load captures
 * its id up front and checks this predicate before any state update. Pure so
 * the out-of-order scenario is unit-testable without mounting the component
 * (the repo harness is node:test on pure helpers, no React/jsdom setup).
 */
export function shouldIgnoreLoad(entryId: number, currentGeneration: number, aborted: boolean): boolean {
  return aborted || entryId !== currentGeneration;
}

/** First-load status for the comments list. loadError set => Retry shown; postsLoaded stays false so a restored reply keeps pending (never silently top-level). */
export type PostsLoadState = { postsLoaded: boolean; loadError: string | null };

export const initialPostsLoadState: PostsLoadState = { postsLoaded: false, loadError: null };

export type PostsLoadOutcome =
  | { kind: "ok" }
  | { kind: "http-error"; status: number }
  | { kind: "invalid" }
  | { kind: "network-error" }
  | { kind: "ignored" };

/**
 * Reducer for the initial comments fetch.
 *
 * Failure paths preserve the draft and its reply destination: postsLoaded
 * stays false (restored reply keeps pending, submit keeps blocking) and a
 * loadError message arms the Retry button. Only "ok" flips postsLoaded and
 * clears the error; "ignored" (abort/stale) leaves state untouched.
 */
export function nextPostsLoadState(prev: PostsLoadState, outcome: PostsLoadOutcome): PostsLoadState {
  switch (outcome.kind) {
    case "ok":
      return { postsLoaded: true, loadError: null };
    case "http-error":
      return { postsLoaded: false, loadError: `Could not load comments (${outcome.status}).` };
    case "invalid":
      return { postsLoaded: false, loadError: "Could not load comments." };
    case "network-error":
      return { postsLoaded: false, loadError: "Could not load comments. Check your connection." };
    case "ignored":
      return prev;
  }
}
