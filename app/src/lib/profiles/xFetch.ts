import "server-only";
import { handleFromAuthorUrl, oembedText, syndicationToken, type PostFacts } from "./xpost";

/**
 * Read one public X post without an API key, from three independent sources:
 *   1. X's oEmbed endpoint (official, the embed-a-post API): author handle + post text
 *   2. X's embed widget data (cdn.syndication.twimg.com): account id, handle, text
 *   3. fxtwitter (third party): account join date, followers, private flag
 * Only X says who wrote what: the post is found, and its author, text and account id taken, only from the two X
 * sources. fxtwitter adds the account facts points use, and only for the account X named. Only X can say a post is
 * gone, and only when it is sure: an X source says 404 and neither X source failed. Anything less certain is
 * "unknown" (null), which sends a new claim to a person and leaves a verified one as it is.
 * Every URL is built here from a validated handle and a numeric id (nothing user-supplied is fetched as given),
 * redirects are not followed, every call has a 5 s timeout, and the returned HTML is only parsed for text.
 */
const TIMEOUT_MS = 5_000;
const UA = "openlaunch.lol profile verification (+https://openlaunch.lol/rules)";

type Res = { status: "ok"; data: unknown } | { status: "missing" } | { status: "error" };

/** GET a JSON URL with a timeout and no redirects: ok with data, missing (404) or error. */
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

/** A non-empty string or null. */
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
/** X account ids are decimal; anything else from a source is ignored rather than stored as the binding key. */
const xid = (v: unknown): string | null => (typeof v === "string" || typeof v === "number" ? (/^\d{1,25}$/.test(String(v)) ? String(v) : null) : null);
/** A finite number or null. */
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A parseable date as ISO-8601, or null. */
const iso = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Read one public post from the three sources and merge what they say (author, account id, text, account age and followers). */
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
      facts.userId = xid(d.user?.id_str);
      facts.text ??= str(d.text);
      facts.sources.push("syndication");
    }
  }

  if (facts.sources.length > 0) {
    facts.found = true;
    // both X sources, when both answered, must name the same author, or nobody is trusted
    const distinct = new Set(handles.map((h) => h.toLowerCase()));
    facts.handle = distinct.size === 1 ? handles[0] : null;
  } else if (oe.status !== "error" && syn.status !== "error" && (oe.status === "missing" || syn.status === "missing")) {
    facts.found = false; // X itself says it is gone, and no X source failed to answer
  }

  // fxtwitter: the account facts only (never the author, the text or the account id), and only for the account X named
  if (facts.found && facts.handle && fx.status === "ok") {
    const d = fx.data as { code?: unknown; tweet?: { id?: unknown; author?: { screen_name?: unknown; followers?: unknown; joined?: unknown; protected?: unknown } } };
    const a = d.tweet?.author;
    if (d.code === 200 && String(d.tweet?.id ?? "") === id && str(a?.screen_name)?.toLowerCase() === facts.handle.toLowerCase()) {
      facts.followers = num(a?.followers);
      facts.accountCreated = iso(a?.joined);
      facts.protected = typeof a?.protected === "boolean" ? a.protected : null;
      facts.sources.push("fxtwitter");
    }
  }
  return facts;
}
