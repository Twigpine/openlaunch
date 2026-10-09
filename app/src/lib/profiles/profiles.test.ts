import { test } from "node:test";
import assert from "node:assert/strict";
import { avatarKeyOf, avatarUrl, checkUsername, cleanBio, cleanDisplayName, cleanText, validateProfile, usernameFromPath } from "./validate.ts";
import { buildProfileMessage, buildProfileModMessage, isNonce, tsFresh } from "./auth.ts";
import { readJson } from "./http.ts";
import { X_CODE_ALPHABET, containsCode, decodeEntities, handleFromAuthorUrl, intentUrl, isXCode, judgePost, makeXCode, oembedText, parsePostUrl, pointsEligible, postTextFor, postTexts, syndicationToken, type CodeRow, type PostFacts } from "./xpost.ts";

// ── usernames ────────────────────────────────────────────────────────────────
test("usernames: lowercase a-z 0-9 _, 3–20, @ and case normalized", () => {
  assert.deepEqual(checkUsername("@Kevin_01"), { ok: true, username: "kevin_01" });
  assert.equal(checkUsername("ab").ok, false);
  assert.equal(checkUsername("a".repeat(21)).ok, false);
  assert.equal(checkUsername("kévin").ok, false, "no accented letters");
  assert.equal(checkUsername("kеvin").ok, false, "no Cyrillic look-alikes");
  assert.equal(checkUsername("ke vin").ok, false);
  assert.equal(checkUsername("_kevin").ok, false);
  assert.equal(checkUsername("kev__in").ok, false);
  assert.equal(checkUsername("0xabc123").ok, false, "cannot look like an address");
});

test("usernames: brand, chains, staff words and routes are reserved", () => {
  for (const u of ["openlaunch", "twigpine", "gitlawb", "base", "coinbase", "robinhood", "admin", "support", "official", "me", "api", "leaderboard", "verified"]) assert.equal(checkUsername(u).ok, false, u);
  for (const u of ["openlaunch_team", "real_twigpine", "gitlawbdev"]) assert.equal(checkUsername(u).ok, false, `${u} contains the brand`);
  assert.equal(checkUsername("baseline").ok, true, "a reserved word inside an ordinary name is fine");
});

// ── display name / bio ───────────────────────────────────────────────────────
test("display names: ticks, invisible and direction characters are stripped", () => {
  assert.deepEqual(cleanDisplayName("Kevin ✓"), { ok: true, value: "Kevin" });
  assert.deepEqual(cleanDisplayName("Kevin ✔️"), { ok: true, value: "Kevin" });
  assert.deepEqual(cleanDisplayName("Ke​vin‮"), { ok: true, value: "Kevin" });
  assert.deepEqual(cleanDisplayName("  many   spaces  "), { ok: true, value: "many spaces" });
  assert.equal(cleanDisplayName("✅").ok, false, "nothing left = required");
  assert.equal(cleanDisplayName("<b>x</b>").ok, false);
  assert.equal(cleanDisplayName("Kevin Verified").ok, false);
});

test("display names: cut at 32 characters without splitting an emoji", () => {
  const r = cleanDisplayName("🌲".repeat(40));
  assert.ok(r.ok);
  assert.equal([...r.value].length, 32);
});

test("bio keeps single line breaks, drops runs, no HTML", () => {
  assert.deepEqual(cleanBio("line one\r\n\r\n\r\nline two"), { ok: true, value: "line one\n\nline two" });
  assert.equal(cleanBio("<script>").ok, false);
  assert.equal(cleanBio("x".repeat(200)).ok && (cleanBio("x".repeat(200)) as { value: string }).value.length, 160);
});

test("avatar: only our own uploaded pictures", () => {
  const key = `t/${"ab".repeat(24)}.webp`;
  assert.deepEqual(avatarKeyOf(key), { ok: true, key });
  assert.deepEqual(avatarKeyOf(`https://openlaunch.lol/api/launch/image/${key}`), { ok: true, key });
  assert.deepEqual(avatarKeyOf(""), { ok: true, key: null });
  assert.equal(avatarKeyOf("https://evil.example/x.png").ok, false);
  assert.equal(avatarUrl(key), `/api/launch/image/${key}`);
  assert.equal(avatarUrl("../../etc/passwd"), null);
});

test("validateProfile normalizes everything at once", () => {
  const r = validateProfile({ username: "@Kevin", display_name: "Kevin", bio: "", avatar: "", x_handle: "https://x.com/KevinCodex?s=21" });
  assert.deepEqual(r, { ok: true, value: { username: "kevin", display_name: "Kevin", bio: "", avatar_key: null, x_handle: "kevincodex" } });
  assert.equal(validateProfile({ username: "kevin", display_name: "Kevin", x_handle: "not a handle!" }).ok, false);
});

// ── messages ─────────────────────────────────────────────────────────────────
test("the profile message names the wallet, nonce, time and every field", () => {
  const m = buildProfileMessage({ wallet: "0xABC", nonce: "a".repeat(32), ts: Date.UTC(2026, 9, 7), fields: { username: "kevin", display_name: "Kevin", bio: "a\nb", avatar_key: null, x_handle: "kevincodex" } });
  assert.match(m, /^openlaunch\.lol wants you to save your public profile\./);
  for (const s of ["Wallet: 0xabc", `Nonce: ${"a".repeat(32)}`, "Issued: 2026-10-07T00:00:00.000Z", "username: kevin", "name: Kevin", "bio: a / b", "x: kevincodex", "moves no funds"]) assert.ok(m.includes(s), s);
});

test("mod messages and nonce / freshness checks", () => {
  assert.match(buildProfileModMessage({ action: "hide", target: "0xDEF", wallet: "0xABC", nonce: "b".repeat(32), ts: 0 }), /Action: hide\nProfile: 0xdef/);
  assert.ok(isNonce("0123456789abcdef0123456789abcdef"));
  assert.ok(!isNonce("xyz"));
  assert.ok(tsFresh(Date.now() - 60_000, Date.now()));
  assert.ok(!tsFresh(Date.now() - 6 * 60_000, Date.now()));
});

// ── X codes ──────────────────────────────────────────────────────────────────
test("codes: OL- + 8 from a 30-letter alphabet with no look-alike characters", () => {
  const c = makeXCode(new Uint8Array(32).map((_, i) => i * 7));
  assert.ok(c && isXCode(c), String(c));
  for (const ch of "01ILOU") assert.ok(!X_CODE_ALPHABET.includes(ch), ch);
  assert.equal(makeXCode(new Uint8Array([255, 254, 253])), null, "bytes over the bias limit are skipped; too few → null");
});

test("codes: a whole word in the post, any case; longer codes do not count", () => {
  assert.ok(containsCode("Verifying my profile\ncode: OL-7K2QXM9A", "OL-7K2QXM9A"));
  assert.ok(containsCode("ol-7k2qxm9a", "OL-7K2QXM9A"));
  assert.ok(!containsCode("OL-7K2QXM9AB", "OL-7K2QXM9A"));
  assert.ok(!containsCode("XOL-7K2QXM9A", "OL-7K2QXM9A"));
  assert.ok(!containsCode("see evil.xyz/OL-7K2QXM9A", "OL-7K2QXM9A"), "inside a link it does not count");
  assert.ok(containsCode("my code is OL-7K2QXM9A.", "OL-7K2QXM9A"), "sentence punctuation after it is fine");
  assert.ok(!containsCode(null, "OL-7K2QXM9A"));
});

test("post links: x.com / twitter.com / mobile, tails ignored, everything else refused", () => {
  assert.deepEqual(parsePostUrl("https://x.com/KevinCodex/status/1975000000000000000?s=46"), { handle: "KevinCodex", id: "1975000000000000000" });
  assert.deepEqual(parsePostUrl("twitter.com/a_b/status/123/photo/1"), { handle: "a_b", id: "123" });
  assert.deepEqual(parsePostUrl("https://mobile.twitter.com/a/statuses/9"), { handle: "a", id: "9" });
  for (const bad of ["https://x.com.evil.com/a/status/1", "https://evil.com/x.com/a/status/1", "https://x.com/i/status/1", "https://x.com/a/likes", "javascript:alert(1)", "https://user:pw@x.com/a/status/1", "https://x.com:8443/a/status/1", ""]) assert.equal(parsePostUrl(bad), null, bad);
});

test("post texts carry the code, the brand account and the profile link; the pick is stable", () => {
  for (const t of postTexts("kevin", "OL-7K2QXM9A", "openlaunch_lol", "openlaunch.lol")) {
    assert.ok(t.includes("OL-7K2QXM9A") && t.includes("@openlaunch_lol") && t.includes("openlaunch.lol/u/kevin"), t);
    assert.ok(t.length <= 280);
  }
  assert.equal(postTextFor("kevin", "OL-7K2QXM9A", "openlaunch_lol", "openlaunch.lol"), postTextFor("kevin", "OL-7K2QXM9A", "openlaunch_lol", "openlaunch.lol"));
  assert.match(intentUrl("a b\nc"), /^https:\/\/x\.com\/intent\/post\?text=a%20b%0Ac$/);
});

test("oEmbed parsing: text out of the blockquote, author from author_url", () => {
  const html = `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Verifying my <a href="https://twitter.com/openlaunch_lol">@openlaunch_lol</a> profile ✓<br><a href="https://t.co/x">openlaunch.lol/u/kevin</a><br>code: OL-7K2QXM9A &amp; more</p>&mdash; Kevin (@KevinCodex) <a href="https://x.com/KevinCodex/status/1">October 7, 2026</a></blockquote>`;
  assert.equal(oembedText(html), "Verifying my @openlaunch_lol profile ✓\nopenlaunch.lol/u/kevin\ncode: OL-7K2QXM9A & more");
  assert.equal(handleFromAuthorUrl("https://x.com/KevinCodex"), "KevinCodex");
  assert.equal(handleFromAuthorUrl("https://evil.com/KevinCodex"), null);
  assert.equal(decodeEntities("&#x1F332; &#39;"), "🌲 '");
  assert.equal(syndicationToken("20"), "6dq1a2xwd93");
});

// ── judging ──────────────────────────────────────────────────────────────────
const now = Date.UTC(2026, 9, 7, 12);
const code: CodeRow = { code: "OL-7K2QXM9A", x_handle: "kevincodex", expires_at: new Date(now + 3_600_000).toISOString(), used_at: null };
const facts = (over: Partial<PostFacts> = {}): PostFacts => ({ found: true, handle: "KevinCodex", userId: "12345", text: "code: OL-7K2QXM9A", accountCreated: "2020-01-01T00:00:00.000Z", followers: 500, protected: false, sources: ["oembed"], ...over });

test("judge: the right account with the code verifies, bound to the account id", () => {
  assert.deepEqual(judgePost({ code, facts: facts(), now }), { ok: true, handle: "kevincodex", userId: "12345" });
  assert.deepEqual(judgePost({ code, facts: facts({ userId: null }), now }), { ok: true, handle: "kevincodex", userId: "h:kevincodex" });
});

test("judge: a copied code posted from another account fails", () => {
  const r = judgePost({ code, facts: facts({ handle: "impostor" }), now });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /from @impostor/);
});

test("judge: missing code, used or expired code, deleted, private, unreadable author", () => {
  assert.equal(judgePost({ code, facts: facts({ text: "hello" }), now }).ok, false);
  assert.equal(judgePost({ code: { ...code, used_at: new Date(now).toISOString() }, facts: facts(), now }).ok, false);
  assert.equal(judgePost({ code: { ...code, expires_at: new Date(now - 1).toISOString() }, facts: facts(), now }).ok, false);
  assert.equal(judgePost({ code, facts: facts({ found: false }), now }).ok, false);
  assert.equal(judgePost({ code, facts: facts({ protected: true }), now }).ok, false);
  assert.equal(judgePost({ code, facts: facts({ handle: null }), now }).ok, false);
});

test("judge: no source answered → a person reviews it", () => {
  const r = judgePost({ code, facts: facts({ found: null, handle: null, text: null }), now });
  assert.equal(r.ok, false);
  assert.equal((r as { review?: boolean }).review, true);
});

test("points eligibility: verified, public, old enough, enough followers, not flagged", () => {
  const p = { x_status: "verified", x_account_created: "2026-01-01T00:00:00.000Z", x_followers: 50, points_flag: null, hidden: false };
  const cfg = { minAgeDays: 30, minFollowers: 20 };
  assert.ok(pointsEligible(p, now, cfg));
  assert.ok(!pointsEligible({ ...p, x_status: "post_missing" }, now, cfg));
  assert.ok(!pointsEligible({ ...p, x_followers: 5 }, now, cfg));
  assert.ok(!pointsEligible({ ...p, x_account_created: new Date(now - 5 * 86_400_000).toISOString() }, now, cfg));
  assert.ok(!pointsEligible({ ...p, points_flag: "excluded" }, now, cfg));
  assert.ok(!pointsEligible({ ...p, x_account_created: null }, now, cfg), "unknown age = not yet");
});

test("oEmbed text can never carry markup, however the input is shaped", () => {
  for (const html of ['<p><scr<script>ipt>alert(1)</p>', '<p>&lt;script&gt;x&lt;/script&gt; OL-7K2QXM9A</p>', '<p>a <b>b</b> <<img src=x>>c</p>']) {
    const t = oembedText(html) ?? "";
    assert.doesNotMatch(t, /[<>]/, html);
  }
  assert.ok(containsCode(oembedText("<p>&lt;script&gt; code: OL-7K2QXM9A</p>"), "OL-7K2QXM9A"), "the code is still found");
});

test("readJson: the size cap holds before buffering, with or without a declared length", async () => {
  const ok = await readJson(new Request("http://x/", { method: "POST", body: JSON.stringify({ a: 1 }) }));
  assert.deepEqual(ok, { a: 1 });
  const declared = await readJson(new Request("http://x/", { method: "POST", headers: { "content-length": "999999" }, body: "{}" }));
  assert.equal(declared, null);
  const big = "x".repeat(20_000);
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`{"a":"${big}"}`)); c.close(); } });
  const streamed = await readJson(new Request("http://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit));
  assert.equal(streamed, null, "no content-length: cut off while reading");
  assert.equal(await readJson(new Request("http://x/", { method: "POST", body: "[1,2]" })), null, "arrays are not objects");
  assert.equal(await readJson(new Request("http://x/", { method: "POST", body: "{bad" })), null);
});

test("usernameFromPath: a malformed or double-encoded path is an unknown profile, never a throw", () => {
  assert.equal(usernameFromPath("Kev_1"), "kev_1");
  assert.equal(usernameFromPath("%40kev_1"), "kev_1", "a double-encoded @ still resolves");
  assert.equal(usernameFromPath("%E0%A4%A"), null, "malformed escape after Next's one decode");
  assert.equal(usernameFromPath("%"), null);
  assert.equal(usernameFromPath("ab"), null, "too short");
  assert.equal(usernameFromPath("kev%2F..%2Fadmin"), null);
});

test("cleaning is idempotent on any input (the server re-cleans what the client cleaned and signed)", () => {
  // a hostile alphabet: combining marks, joiners and selectors, invisibles, ticks, emoji parts, tags, whitespace
  const parts = ["e", "a", "o", "́", "̈", "​", "‌", "‍", "­", "⁠", "️", "︎", "︀", "✓", "✅", "👨", "💻", "🏳", "🌈", "❤", "🇵", "🇭", "🏴", "\u{e0067}", "\u{e0062}", "\u{e007f}", "\u{1f3fd}", "1", "⃣", " ", "\n", "\t", "‮", "<", "x"];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 5000; i++) {
    const s = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => parts[Math.floor(rnd() * parts.length)]).join("");
    for (const [max, multiline] of [[32, false], [160, true], [8, false]] as const) {
      const once = cleanText(s, max, { multiline });
      assert.equal(cleanText(once, max, { multiline }), once, JSON.stringify(s));
      assert.ok([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(once)].length <= max);
    }
  }
});

test("names that came out different on a second clean now save as written", () => {
  for (const raw of ["Jose​́", "Re­́my", "e✓́"]) {
    const v = cleanDisplayName(raw);
    assert.ok(v.ok);
    const again = cleanDisplayName(v.ok ? v.value : "");
    assert.deepEqual(again, v, raw);
  }
});

test("emoji keep their joiners and selectors; stray ones still go; a cut never splits an emoji", () => {
  for (const e of ["Kevin 👨‍💻", "❤️", "🏳️‍🌈", "1️⃣", "👍🏽", "🇵🇭", "🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}"]) {
    assert.equal(cleanText(e, 32), e.normalize("NFC"), e);
  }
  assert.equal(cleanText("ad‍min", 32), "admin", "a joiner between letters is invisible: removed");
  assert.equal(cleanText("a️b", 32), "ab", "a selector after a letter: removed");
  assert.equal(cleanText("x\u{e0067}\u{e0062}y", 32), "xy", "tags outside a flag: removed");
  assert.equal(cleanText("ab👨‍💻", 3), "ab👨‍💻", "the emoji counts as one character");
  assert.equal(cleanText("abc👨‍💻", 3), "abc", "and is dropped whole, never half");
  assert.equal(cleanText("🇵🇭🇵🇭", 1), "🇵🇭", "a flag is never cut to a lone letter");
});

test("usernames: nothing that reads as an address, a reserved name or the brand in disguise", () => {
  for (const u of ["0xd8da_6045", "0x_kev", "0xabc"]) assert.equal(checkUsername(u).ok, false, u);
  for (const u of ["0penlaunch_team", "open_launch", "g1tlawb", "tw1gpine", "adm1n", "supp0rt", "m0d"]) assert.equal(checkUsername(u).ok, false, u);
  for (const u of ["kevin", "alice_99", "x_kev", "ox_trader", "dev_1"]) assert.equal(checkUsername(u).ok, true, u);
});

test("verification posts @-mention only our account, never the username (it is not an X handle)", () => {
  for (const t of postTexts("bob", "OL-7K2QXM9A", "openlaunch_lol", "openlaunch.lol")) {
    const mentions = [...t.matchAll(/@(\w+)/g)].map((m) => m[1]);
    assert.deepEqual(mentions, ["openlaunch_lol"], t);
    assert.ok(t.includes("OL-7K2QXM9A") && t.includes("openlaunch.lol/u/bob"), t);
  }
});
