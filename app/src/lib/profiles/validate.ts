/**
 * Profile field rules (pure; node --test loads this directly, relative imports only).
 *
 * The username is the identity people see in trades, so it is plain on purpose: a–z, 0–9 and _, 3 to 20
 * characters, stored lowercase. That alone rules out look-alike letters from other scripts. Names that read as
 * ours, as a chain or as a staff role are reserved, and so is every top-level route. The display name is free
 * text, but it can never carry a tick (only the verified badge draws one) or invisible / direction characters.
 */
import { parseXHandle } from "../launchpad/xHandle.ts";
import { storedImageKey } from "../launchpad/images.ts";

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const USERNAME_MAX = 20;
export const DISPLAY_NAME_MAX = 32;
export const BIO_MAX = 160;

/** Exact names nobody can take: the brand family, chains and partners, staff roles, and every top-level route. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // brand family
  "openlaunch", "openlaunch_lol", "openlaunchlol", "twigpine", "twig", "gitlawb", "museworld", "kevincodex",
  // chains and partners people would read as official
  "base", "basechain", "coinbase", "robinhood", "arc", "circle", "uniswap", "ethereum", "eth", "usdc", "usdg", "bankr", "clanker", "farcaster", "x", "twitter",
  // staff and system words
  "admin", "admins", "administrator", "mod", "mods", "moderator", "support", "help", "helpdesk", "official", "team", "staff", "security",
  "dev", "devs", "developer", "root", "system", "sysadmin", "owner", "founder", "verified", "verify", "bot", "null", "undefined", "anonymous", "deleted",
  // top-level routes and reserved paths
  "u", "t", "me", "api", "launch", "rules", "about", "agents", "feed", "leaderboard", "points", "season", "seasons", "profile", "profiles",
  "settings", "login", "signup", "logout", "new", "edit", "search", "explore", "home", "terms", "privacy", "llms", "sitemap", "robots", "favicon",
]);
/** Substrings that make a name read as the brand anywhere in it ("openlaunch_team", "real_twigpine"). */
export const RESERVED_FRAGMENTS: readonly string[] = ["openlaunch", "twigpine", "gitlawb"];

/**
 * The ways a name can read as a reserved one: as typed, without underscores, and with digits read as the letters
 * they stand in for ("0penlaunch", "open_launch", "g1tlawb", "adm1n").
 */
function readings(u: string): string[] {
  const bare = u.replace(/_/g, "");
  const leet = (s: string, one: string) => s.replace(/0/g, "o").replace(/1/g, one).replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t").replace(/8/g, "b");
  return [...new Set([u, bare, leet(bare, "l"), leet(bare, "i")])];
}

/** A username as typed, trimmed, without a leading @, lowercase. */
export function normalizeUsername(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/^@/, "").toLowerCase() : "";
}

/**
 * The username a /u/<username> path asks for, or null when it cannot be one. The path segment arrives decoded once;
 * a second decode undoes a client's double encoding, and a malformed escape left after that is an unknown profile
 * rather than a thrown URIError.
 */
export function usernameFromPath(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const u = normalizeUsername(decoded);
  return /^[a-z0-9_]{3,20}$/.test(u) ? u : null;
}

/** Whether a username is allowed (shape, underscores, not address-like, not reserved). */
export function checkUsername(raw: unknown): { ok: true; username: string } | { ok: false; error: string } {
  const u = normalizeUsername(raw);
  if (!USERNAME_RE.test(u)) return { ok: false, error: "username: 3–20 letters, numbers or _" };
  if (/^_|_$/.test(u) || u.includes("__")) return { ok: false, error: "username: no leading, trailing or double _" };
  // 0x… reads as an address everywhere a wallet is shown short ("0xd8da_6045" next to "0xd8dA…6045")
  if (u.startsWith("0x")) return { ok: false, error: "username: cannot start with 0x (it reads as an address)" };
  const r = readings(u);
  if (r.some((x) => RESERVED_USERNAMES.has(x)) || RESERVED_FRAGMENTS.some((f) => r.some((x) => x.includes(f)))) return { ok: false, error: "username: reserved" };
  return { ok: true, username: u };
}

// C0/C1 controls (the multiline form keeps \n), soft hyphen, zero-width characters, bidi overrides and isolates,
// word joiner…invisible operators, variation selectors, BOM and Hangul fillers: anything that renders as nothing or
// reorders the text around it. The emoji joiner (U+200D), the two presentation selectors (U+FE0E/F) and the tag
// characters are handled apart: they are kept only inside the emoji that need them.
const HIDDEN = "\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b\\u200c\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0d\\ufeff\\uffa0";
const INVISIBLE = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${HIDDEN}]|[\\u{e0100}-\\u{e01ef}]`, "gu");
const INVISIBLE_KEEP_NL = new RegExp(`[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f${HIDDEN}]|[\\u{e0100}-\\u{e01ef}]`, "gu");
// a joiner only between two emoji (👨‍💻, 🏳️‍🌈); a presentation selector only right after an emoji or a keycap base
// (❤️, 1️⃣) and never twice; tag characters only inside a subdivision flag (🏴 + tags + cancel tag)
const STRAY_JOINER = /(?<![\p{Extended_Pictographic}\p{Emoji_Modifier}\ufe0f])\u200d|\u200d(?!\p{Extended_Pictographic})/gu;
const STRAY_SELECTOR = /(?<![\p{Extended_Pictographic}0-9#*])[\ufe0e\ufe0f]/gu;
const TAGS = /(\u{1f3f4}[\u{e0030}-\u{e0039}\u{e0061}-\u{e007a}]{1,7}\u{e007f})|[\u{e0000}-\u{e007f}]/gu;
// everything that reads as a tick: ✓ ✔ ☑ ✅ √ ⍻ 🗸 🗹 (the verified badge is the only tick on the page)
const TICKS = /[\u2713\u2714\u2611\u2705\u221a\u237b\u{1f5f8}\u{1f5f9}]/gu;
const graphemes: Intl.Segmenter | null = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** One cleaning pass: strip, NFC, collapse whitespace, cut to `max` whole characters (an emoji is never cut in half). */
function cleanOnce(s: string, max: number, multiline: boolean): string {
  if (multiline) s = s.replace(/\r\n?/g, "\n");
  s = s
    .replace(multiline ? INVISIBLE_KEEP_NL : INVISIBLE, "")
    .replace(TAGS, (_m, flag: string | undefined) => flag ?? "")
    .replace(TICKS, "")
    .replace(STRAY_JOINER, "")
    .replace(STRAY_SELECTOR, "")
    .normalize("NFC");
  s = multiline ? s.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n") : s.replace(/\s+/g, " ");
  s = s.trim();
  const chars = graphemes ? [...graphemes.segment(s)].map((g) => g.segment) : [...s];
  return chars.length > max ? chars.slice(0, max).join("").trim() : s;
}

/**
 * Strip invisible / direction characters and ticks, NFC-normalize, collapse whitespace, cut to `max` characters.
 * Repeated until nothing changes, so cleaning is idempotent: clean(clean(x)) === clean(x) for every input (NFC can
 * compose across a character that a pass removed, which is why one pass is not enough).
 */
export function cleanText(raw: unknown, max: number, opts: { multiline?: boolean } = {}): string {
  if (typeof raw !== "string") return "";
  let s = raw;
  for (let i = 0; i < 6; i++) {
    const next = cleanOnce(s, max, Boolean(opts.multiline));
    if (next === s) break;
    s = next;
  }
  return s;
}

/** A display name with invisible characters and ticks removed; required, no HTML, never says verified. */
export function cleanDisplayName(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const v = cleanText(raw, DISPLAY_NAME_MAX);
  if (!v) return { ok: false, error: "name: required" };
  if (/<[a-z!/]/i.test(v)) return { ok: false, error: "name: no HTML" };
  if (/\bverified\b/i.test(v)) return { ok: false, error: "name: cannot say verified" };
  return { ok: true, value: v };
}

/** A bio with invisible characters removed, single blank lines kept, at most 160 characters, no HTML. */
export function cleanBio(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const v = cleanText(raw, BIO_MAX, { multiline: true });
  if (/<[a-z!/]/i.test(v)) return { ok: false, error: "bio: no HTML" };
  return { ok: true, value: v };
}

/** Avatar: only a picture in our own image store (an uploaded, re-encoded WebP). Accepts the stored key or its URL. */
export function avatarKeyOf(raw: unknown): { ok: true; key: string | null } | { ok: false; error: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { ok: true, key: null };
  const key = /^t\/[0-9a-f]{48}\.webp$/.test(s) ? s : storedImageKey(s);
  return key ? { ok: true, key } : { ok: false, error: "avatar: upload a picture" };
}

/** Same-origin URL for a stored avatar key. */
export function avatarUrl(key: string | null | undefined): string | null {
  return key && /^t\/[0-9a-f]{48}\.webp$/.test(key) ? `/api/launch/image/${key}` : null;
}

export type ProfileFields = { username: string; display_name: string; bio: string; avatar_key: string | null; x_handle: string };

/** Validate and normalize a whole profile form. The X handle is optional; it only starts verification. */
export function validateProfile(f: Partial<Record<"username" | "display_name" | "bio" | "avatar" | "x_handle", unknown>>): { ok: true; value: ProfileFields } | { ok: false; error: string } {
  const u = checkUsername(f.username);
  if (!u.ok) return u;
  const d = cleanDisplayName(f.display_name);
  if (!d.ok) return d;
  const b = cleanBio(f.bio);
  if (!b.ok) return b;
  const a = avatarKeyOf(f.avatar);
  if (!a.ok) return a;
  const x = parseXHandle(f.x_handle);
  if (!x.ok) return { ok: false, error: x.error };
  return { ok: true, value: { username: u.username, display_name: d.value, bio: b.value, avatar_key: a.key, x_handle: x.handle.toLowerCase() } };
}
