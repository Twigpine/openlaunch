import "server-only";
import { handleFromAuthorUrl, oembedText, syndicationToken, type PostFacts } from "./xpost";

/**
 * Read one public X post without an API key, from three independent sources:
 *   1. X's oEmbed endpoint (official, the embed-a-post API): author handle + post text
 *   2. X's embed widget data (cdn.syndication.twimg.com): account id, handle, text
 *   3. fxtwitter (third party): account join date, followers, private flag
 * Only the two X sources can say a post is gone (404); a third-party failure is never read as "deleted".
 * Every URL is built here from a validated handle and a numeric id (nothing user-supplied is fetched as given),
 * redirects are not followed, every call has a 5 s timeout, and the returned HTML is only parsed for text.
 */
const TIMEOUT_MS = 5_000;
const UA = "openlaunch.lol profile verification (+https://openlaunch.lol/rules)";

type Res = { status: "ok"; data: unknown } | { status: "missing" } | { status: "error" };

async function getJson(url: string): Promise<Res> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    if (r.status === 404) return { status: "missing" };
    if (!r.ok) return { status: "error" };
    return { status: "ok", data: await r.json() };
  } catch {
    return { status: "error" };
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export async function fetchPostFacts(handle: string, id: string): Promise<PostFacts> {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle) || !/^\d{1,20}$/.test(id)) return { found: false, handle: null, userId: null, text: null, accountCreated: null, followers: null, protected: null, sources: [] };
  const postUrl = `https://x.com/${handle}/status/${id}`;
  const [oe, syn, fx] = await Promise.all([
    getJson(`https://publish.x.com/oembed?url=${encodeURIComponent(postUrl)}&omit_script=1&dnt=1`),
    getJson(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=en`),
    getJson(`https://api.fxtwitter.com/${handle}/status/${id}`),
  ]);
  const facts: PostFacts = { found: null, handle: null, userId: null, text: null, accountCreated: null, followers: null, protected: null, sources: [] };
  const handles: string[] = [];

  if (oe.status === "ok") {
    const d = oe.data as { author_url?: unknown; html?: unknown };
    const h = handleFromAuthorUrl(d.author_url);
    const text = typeof d.html === "string" ? oembedText(d.html) : null;
    if (h) {
      handles.push(h);
      facts.text = text;
      facts.sources.push("oembed");
    }
  }
  if (syn.status === "ok") {
    const d = syn.data as { id_str?: unknown; text?: unknown; user?: { id_str?: unknown; screen_name?: unknown } };
    const h = str(d.user?.screen_name);
    if (str(d.id_str) === id && h) {
      handles.push(h);
      facts.userId = str(d.user?.id_str);
      facts.text ??= str(d.text);
      facts.sources.push("syndication");
    }
  }
  if (fx.status === "ok") {
    const d = fx.data as { code?: unknown; tweet?: { id?: unknown; text?: unknown; author?: { id?: unknown; screen_name?: unknown; followers?: unknown; joined?: unknown; protected?: unknown } } };
    const a = d.tweet?.author;
    const h = str(a?.screen_name);
    if (d.code === 200 && String(d.tweet?.id ?? "") === id && h) {
      handles.push(h);
      facts.userId ??= str(a?.id);
      facts.text ??= str(d.tweet?.text);
      facts.followers = num(a?.followers);
      facts.accountCreated = iso(a?.joined);
      facts.protected = typeof a?.protected === "boolean" ? a.protected : null;
      facts.sources.push("fxtwitter");
    }
  }

  if (facts.sources.length > 0) {
    facts.found = true;
    // every source that answered must name the same author, or nobody is trusted
    const distinct = new Set(handles.map((h) => h.toLowerCase()));
    facts.handle = distinct.size === 1 ? handles[0] : null;
  } else if (oe.status === "missing" || syn.status === "missing") {
    facts.found = false;
  }
  return facts;
}
