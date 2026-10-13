/**
 * X verification, the pure half (node --test loads this directly).
 *
 * Flow: a signed profile save names an X handle → the server mints a one-time code bound to the wallet and that
 * handle (24 h) → the person posts it from that account (an intent link pre-fills the post) → pastes the post link →
 * the server reads the public post (xFetch.ts) and `judgePost` decides. The code is random and unknown before it is
 * issued, so a post that contains it was written after it was issued; no post-time check is needed. The post
 * itself earns nothing: it only proves who the account is (X does not allow apps that reward posting).
 */

export const X_CODE_PREFIX = "OL-";
/** No 0/O, 1/I/L or U: nothing to misread when someone types the code by hand. */
export const X_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const X_CODE_LEN = 8;
export const X_CODE_TTL_MS = 24 * 60 * 60_000;

/** A code from random bytes (rejection sampling: no modulo bias). Returns null when the bytes ran out. */
export function makeXCode(rand: Uint8Array): string | null {
  const n = X_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  for (const b of rand) {
    if (b >= limit) continue;
    out += X_CODE_ALPHABET[b % n];
    if (out.length === X_CODE_LEN) return X_CODE_PREFIX + out;
  }
  return null;
}

/** Whether a value is a well-formed X code. */
export function isXCode(v: unknown): v is string {
  return typeof v === "string" && new RegExp(`^${X_CODE_PREFIX}[${X_CODE_ALPHABET}]{${X_CODE_LEN}}$`).test(v);
}

/**
 * The code as its own word in the post (case-insensitive): whitespace or the start before it, whitespace, the end or
 * sentence punctuation after it. Inside a link ("site.xyz/OL-…") or a longer code it does not count.
 */
export function containsCode(text: string | null | undefined, code: string): boolean {
  if (!text || !isXCode(code)) return false;
  return new RegExp(`(^|\\s)${code.replace("-", "\\-")}(?=$|\\s|[.,!?;:)])`, "i").test(text);
}

/** A post link as people paste it (x.com, twitter.com, mobile, with ?s= or /photo/1 tails). Null for anything else. */
export function parsePostUrl(raw: unknown): { handle: string; id: string } | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > 300) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  if (!/^((www|mobile|m)\.)?(x|twitter)\.com$/i.test(u.hostname)) return null;
  const m = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,20})(?:\/.*)?$/.exec(u.pathname);
  if (!m || m[1].toLowerCase() === "i") return null;
  return { handle: m[1], id: m[2] };
}

/**
 * Post texts, rotated so a wave of identical posts does not look like spam. Code, our @handle and link always present.
 * The only account a post ever @-mentions is ours: an openlaunch username is not an X handle, and "@<username>" would
 * tag (and notify) whoever owns that name on X.
 */
export function postTexts(username: string, code: string, brandX: string, domain: string): string[] {
  const link = `${domain}/u/${username}`;
  return [
    `Verifying my @${brandX} profile ✓\n${link}\ncode: ${code}`,
    `I'm ${username} on @${brandX}, free token launches on Base\n${link}\n${code}`,
    `Claiming ${link} on @${brandX}\nverification: ${code}`,
  ];
}

/** One text per code (stable for the same code, so a reload shows the same post). */
export function postTextFor(username: string, code: string, brandX: string, domain: string): string {
  const texts = postTexts(username, code, brandX, domain);
  let h = 0;
  for (const c of code) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return texts[h % texts.length];
}

/** X's compose link with the post text filled in. */
export function intentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

/** The token X's own embed widget sends with tweet-result requests. */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…" };
/** Decode the HTML entities oEmbed uses (named ones it emits, and numeric ones). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Markup → text in one pass: everything from a `<` to the next `>` is dropped (a `<br>` becomes a line break), and an
 * unclosed `<` drops the rest. A single scan, so no tag can be rebuilt from the pieces of another.
 */
function stripTags(html: string): string {
  let out = "";
  let tag: string | null = null;
  for (const ch of html) {
    if (tag === null) {
      if (ch === "<") tag = "";
      else out += ch;
    } else if (ch === ">") {
      if (/^br\s*\/?$/i.test(tag)) out += "\n";
      tag = null;
    } else {
      tag += ch;
    }
  }
  return out;
}

/**
 * The post text inside X's oEmbed HTML (`<blockquote><p>…</p>— name (@handle) <a>date</a></blockquote>`), as plain
 * text. It is only ever searched for the code, never rendered; still, after the tags are dropped and the entities
 * decoded, every remaining angle bracket goes too, so no markup can survive in it however the input is shaped.
 */
export function oembedText(html: string): string | null {
  const m = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  if (!m) return null;
  return decodeEntities(stripTags(m[1])).replace(/[<>]/g, "").trim();
}

/** Handle from an oEmbed author_url (https://x.com/<handle>). */
export function handleFromAuthorUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i.exec(url.trim());
  return m ? m[1] : null;
}

/** What the public lookups said about one post. found: true = a source returned it, false = sources say it is gone, null = no source answered. */
export type PostFacts = {
  found: boolean | null;
  handle: string | null;
  userId: string | null;
  text: string | null;
  accountCreated: string | null;
  followers: number | null;
  protected: boolean | null;
  sources: string[];
};

export type CodeRow = { code: string; x_handle: string; expires_at: string; used_at: string | null };

export type Judgement = { ok: true; handle: string; userId: string } | { ok: false; error: string; review?: boolean };

/** Decide one verification attempt. `review` = no source answered: the attempt can go to a person instead. */
export function judgePost(p: { code: CodeRow; facts: PostFacts; now: number }): Judgement {
  const { code, facts } = p;
  if (code.used_at) return { ok: false, error: "that code was already used; save your profile again for a new one" };
  if (new Date(code.expires_at).getTime() <= p.now) return { ok: false, error: "that code expired; save your profile again for a new one" };
  if (facts.found === null) return { ok: false, error: "X did not answer; we sent your post to a person to check", review: true };
  if (facts.found === false) return { ok: false, error: "could not find that post; check the link (posts from private accounts cannot be read)" };
  if (facts.protected) return { ok: false, error: "that account is private; make the post public to verify" };
  if (!facts.handle) return { ok: false, error: "could not read who wrote that post; try again in a minute" };
  if (facts.handle.toLowerCase() !== code.x_handle.toLowerCase()) return { ok: false, error: `that post is from @${facts.handle}, but this code is for @${code.x_handle}` };
  if (!containsCode(facts.text, code.code)) return { ok: false, error: `the code ${code.code} is not in that post` };
  return { ok: true, handle: facts.handle.toLowerCase(), userId: facts.userId ?? `h:${facts.handle.toLowerCase()}` };
}

/** Points eligibility (Season rules): a verified, public X account at least `minAgeDays` old with `minFollowers`. */
export function pointsEligible(p: { x_status: string; x_account_created: string | null; x_followers: number | null; points_flag: string | null; hidden: boolean }, now: number, cfg: { minAgeDays: number; minFollowers: number }): boolean {
  if (p.hidden || p.points_flag || p.x_status !== "verified") return false;
  if (!p.x_account_created || p.x_followers === null) return false;
  return now - new Date(p.x_account_created).getTime() >= cfg.minAgeDays * 86_400_000 && p.x_followers >= cfg.minFollowers;
}
