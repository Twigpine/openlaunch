/**
 * The X field, as people actually fill it in: a handle (`foo`, `@foo`) or a profile link pasted from the
 * app (`https://x.com/foo?s=21`, `twitter.com/foo/status/1`). Pure; the launch and edit validators share it.
 *
 * Only the bare handle is ever stored, and pages build `https://x.com/<handle>` themselves, so a pasted
 * URL is never rendered as a link target.
 */
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const HOSTS = new Set(["x.com", "twitter.com"]);
/** First path segments on x.com that are pages, not profiles. Checked on links only: a typed handle is taken as given. */
const RESERVED = new Set(["home", "i", "intent", "share", "search", "explore", "settings", "hashtag", "messages", "notifications", "compose", "login", "signup"]);
export const X_HANDLE_ERROR = "x: a handle or an x.com link";
const MAX_INPUT = 200;

export function parseXHandle(input: unknown): { ok: true; handle: string } | { ok: false; error: string } {
  const bad = { ok: false as const, error: X_HANDLE_ERROR };
  const s = typeof input === "string" ? input.trim() : "";
  if (!s) return { ok: true, handle: "" };
  if (s.length > MAX_INPUT) return bad;
  let handle = s.replace(/^@/, "");
  if (!HANDLE.test(handle)) {
    let u: URL;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      return bad;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return bad;
    if (!HOSTS.has(u.hostname.toLowerCase().replace(/^(www|mobile|m)\./, ""))) return bad;
    handle = (u.pathname.split("/").find(Boolean) ?? "").replace(/^@/, "");
    if (!HANDLE.test(handle) || RESERVED.has(handle.toLowerCase())) return bad;
  }
  return { ok: true, handle };
}
