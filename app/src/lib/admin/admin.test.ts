import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createSiweMessage } from "viem/siwe";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ADMIN_MESSAGE_TTL_MS, ADMIN_SESSION_MS, ADMIN_SESSIONS_MAX, ADMIN_SIGN_IN_STATEMENT, buildAdminSignInMessage, checkAdminSignIn, deviceLabel } from "./signIn.ts";
import { ADMIN_COOKIE, adminCookieOptions, hashToken, isToken, requireAdmin, requireAdminAction, tokenFromCookieHeader } from "./session.ts";
import { verifySig } from "../profiles/server.ts";

const SRC = path.resolve(import.meta.dirname, "../..");
const src = (rel: string) => readFileSync(path.join(SRC, rel), "utf8").replaceAll("\r\n", "\n");

const ORIGIN = "https://openlaunch.lol";
const account = privateKeyToAccount(generatePrivateKey());
const NONCE = "a".repeat(48);
const ISSUED = new Date("2026-10-17T03:00:00.000Z");
const T = ISSUED.getTime();
const signIn = (over: Partial<{ origin: string; address: string; nonce: string; issuedAt: Date }> = {}) =>
  buildAdminSignInMessage({ origin: ORIGIN, address: account.address, nonce: NONCE, issuedAt: ISSUED, ...over });
const check = (message: unknown, now = T + 1_000) => checkAdminSignIn(message, { origins: [ORIGIN], now });

test("the sign-in is a standard Sign-In with Ethereum message for openlaunch.lol on Base", () => {
  const m = signIn();
  assert.match(m, /^openlaunch\.lol wants you to sign in with your Ethereum account:\n0x[0-9a-fA-F]{40}\n\n/, "wallets compare this domain with the site asking");
  assert.ok(m.includes(`\n\n${ADMIN_SIGN_IN_STATEMENT}\n\n`));
  assert.match(m, /\nURI: https:\/\/openlaunch\.lol\nVersion: 1\nChain ID: 8453\nNonce: a{48}\nIssued At: 2026-10-17T03:00:00\.000Z\nExpiration Time: 2026-10-17T03:05:00\.000Z$/);
  const c = check(m);
  assert.deepEqual(c, { ok: true, wallet: account.address.toLowerCase(), nonce: NONCE });
});

test("a sign-in made for another site, scheme or host is refused", () => {
  for (const origin of ["https://openlaunch.lol.evil.example", "https://www.openlaunch.lol", "http://openlaunch.lol", "https://basebid.lol"]) {
    const c = check(signIn({ origin }));
    assert.equal(c.ok, false, origin);
    if (!c.ok) assert.equal(c.error, "this sign-in was made for another site", origin);
  }
});

test("only the exact text this site builds is accepted: no other chain, statement, field or formatting", () => {
  const base = { domain: "openlaunch.lol", address: account.address, uri: ORIGIN, version: "1" as const, nonce: NONCE, issuedAt: ISSUED, expirationTime: new Date(T + ADMIN_MESSAGE_TTL_MS) };
  const other = (over: Record<string, unknown>) => createSiweMessage({ ...base, statement: ADMIN_SIGN_IN_STATEMENT, chainId: 8453, ...over } as Parameters<typeof createSiweMessage>[0]);
  const refused = (m: string, why: string) => assert.equal(check(m).ok, false, why);
  assert.equal(check(other({})).ok, true, "the same fields built by viem directly are the same text");
  refused(other({ chainId: 1 }), "mainnet");
  refused(other({ statement: "Sign in to openlaunch" }), "another statement");
  refused(other({ resources: ["https://openlaunch.lol/api/pairs/mod"] }), "resources");
  refused(other({ requestId: "x" }), "a request id");
  refused(other({ notBefore: ISSUED }), "not before");
  refused(other({ expirationTime: new Date(T + 24 * 3600_000) }), "a day-long expiry");
  refused(other({ expirationTime: undefined }), "no expiry");
  refused(signIn() + "\n", "a trailing newline");
  refused(signIn().replace(account.address, account.address.toLowerCase()), "a non-checksummed address");
  for (const bad of [undefined, null, 42, "", "x".repeat(2_001), "hello"]) refused(bad as string, String(bad).slice(0, 20));
});

test("a sign-in is good for 5 minutes, and a wallet clock far ahead is refused", () => {
  assert.equal(check(signIn(), T + ADMIN_MESSAGE_TTL_MS - 1).ok, true);
  const expired = check(signIn(), T + ADMIN_MESSAGE_TTL_MS);
  assert.ok(!expired.ok && /expired/.test(expired.error));
  assert.equal(check(signIn(), T - 30_000).ok, true, "30 s of skew is fine");
  const ahead = check(signIn(), T - 2 * 60_000);
  assert.ok(!ahead.ok && /clock/.test(ahead.error));
});

test("a plain wallet's sign-in signature checks out locally (no RPC)", async () => {
  const m = signIn();
  assert.equal(await verifySig(account.address.toLowerCase(), [m], await account.signMessage({ message: m }), "base"), "ok");
});

test("sessions: 8 hours, at most 5 per wallet", () => {
  assert.equal(ADMIN_SESSION_MS, 8 * 3600_000);
  assert.equal(ADMIN_SESSIONS_MAX, 5);
});

test("the cookie: HttpOnly, SameSite=Strict, Path=/, Secure and __Host- in production", () => {
  const o = adminCookieOptions(new Date(0));
  assert.equal(o.httpOnly, true);
  assert.equal(o.sameSite, "strict");
  assert.equal(o.path, "/");
  assert.equal(ADMIN_COOKIE, "ol_admin", "tests run outside production");
  const s = src("lib/admin/session.ts");
  assert.match(s, /export const ADMIN_COOKIE = PROD \? "__Host-ol_admin" : "ol_admin";/);
  assert.match(s, /return \{ httpOnly: true, secure: PROD, sameSite: "strict" as const, path: "\/", expires \};/);
  assert.doesNotMatch(s, /domain:/, "no Domain: __Host- binds it to openlaunch.lol exactly");
});

test("the token: 32 random bytes; only its SHA-256 is ever stored or looked up", () => {
  const token = "A".repeat(43);
  assert.equal(isToken(token), true);
  for (const bad of ["A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, `${"A".repeat(42)};`, null, 1]) assert.equal(isToken(bad), false, String(bad));
  assert.match(hashToken(token), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken(token), hashToken("B".repeat(43)));
  const s = src("lib/admin/session.ts");
  assert.match(s, /const token = randomBytes\(32\)\.toString\("base64url"\);/);
  assert.match(s, /INSERT INTO bb_admin_sessions \(token_hash, wallet, device, expires_at\) VALUES \(\$\{hashToken\(token\)\},/);
  assert.match(s, /WHERE token_hash = \$\{hashToken\(token\)\} AND revoked_at IS NULL AND expires_at > now\(\)`;/);
  for (const m of s.matchAll(/(?:db|t)`[^`]*`/g)) assert.doesNotMatch(m[0], /\$\{token\}/, "the raw token never reaches SQL");
  assert.match(src("../db/schema.sql"), /token_hash   text NOT NULL UNIQUE,/);
});

test("a session counts only while its wallet is still an admin, a removed wallet's sessions end for good, and past the cap the oldest end", () => {
  const s = src("lib/admin/session.ts");
  const fromToken = s.slice(s.indexOf("export async function adminSessionFromToken("), s.indexOf("export async function adminFromRequest("));
  assert.match(fromToken, /if \(!adminWallets\(\)\.has\(row\.wallet\)\) return null;/);
  // a machine still on the old ADMIN_WALLETS while a secret change rolls out must not end a newly added admin's sessions
  assert.doesNotMatch(fromToken, /revoked_at = now\(\)/, "a request never ends sessions");
  assert.match(s, /UPDATE bb_admin_sessions SET revoked_at = now\(\) WHERE revoked_at IS NULL AND wallet <> ALL\(\$\{\[\.\.\.adminWallets\(\)\]\}::text\[\]\)/, "the boot sweep");
  assert.match(s, /export async function revokeNonAdminSessions\(tries = 3, waitMs = 10_000\)[\s\S]*?if \(i >= tries\) throw err;\n\s*await new Promise\(\(r\) => setTimeout\(r, waitMs\)\);/, "a database blip at boot does not skip the sweep");
  assert.match(src("instrumentation.ts"), /const \{ revokeNonAdminSessions \} = await import\("\.\/lib\/admin\/session"\);\n\s*void revokeNonAdminSessions\(\)/, "runs at boot, which a secret change triggers");
  assert.match(s, /ORDER BY created_at DESC, id DESC LIMIT \$\{ADMIN_SESSIONS_MAX\}\)/);
});

test("the cookie is read by name, and a malformed value is no session", () => {
  const t = "Zz9_-".repeat(8) + "abc";
  assert.equal(tokenFromCookieHeader(`theme=dark; ${ADMIN_COOKIE}=${t}; x=1`), t);
  assert.equal(tokenFromCookieHeader(`${ADMIN_COOKIE}=${t.slice(1)}`), null);
  assert.equal(tokenFromCookieHeader(`x${ADMIN_COOKIE}=${t}`), null);
  assert.equal(tokenFromCookieHeader(null), null);
});

test("an unknown token, a missing cookie or a wallet in the URL is no session; no database or a failed read refuses", async () => {
  const req = (headers: Record<string, string>, url = "https://openlaunch.lol/api/posts/reported") => new Request(url, { headers });
  const none = { ok: false, error: "admin session needed: sign in at /admin", status: 401 };
  assert.deepEqual(await requireAdmin(req({ cookie: `${ADMIN_COOKIE}=${"A".repeat(43)}` })), none);
  assert.deepEqual(await requireAdmin(req({})), none);
  assert.deepEqual(await requireAdmin(req({}, "https://openlaunch.lol/api/posts/reported?wallet=0x0000000000000000000000000000000000000001")), none);
  // an action must also come from the site's own pages and name the wallet that signed it
  const w = "0x0000000000000000000000000000000000000001";
  const site = { origin: "http://localhost:3000" };
  assert.deepEqual(await requireAdminAction(req({}), w), { ok: false, error: "bad origin", status: 403 });
  assert.deepEqual(await requireAdminAction(req({ origin: "https://evil.example" }), w), { ok: false, error: "bad origin", status: 403 });
  assert.deepEqual(await requireAdminAction(req(site), w), none, "the right origin still needs a session");
  // a missing or malformed wallet is refused, never let through as a read would be
  for (const bad of [undefined, null, 1, "", "0x01", `${w}0`, { wallet: w }]) {
    assert.deepEqual(await requireAdminAction(req({ ...site, cookie: `${ADMIN_COOKIE}=${"A".repeat(43)}` }), bad), { ok: false, error: "bad wallet", status: 400 }, String(bad));
  }
  const s = src("lib/admin/session.ts");
  assert.match(s, /if \(!maybeDb\(\)\) return fail\("db unconfigured", 503\);/);
  assert.match(s, /\} catch \(err\) \{\n\s*console\.error\("\[admin\] session check failed:"[^\n]*\n\s*return fail\("admin check unavailable, try again", 503\);/);
});

test("device labels are browser · OS only", () => {
  assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"), "Chrome · macOS");
  assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Safari · iOS");
  assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"), "Edge · Windows");
  assert.equal(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"), "Firefox · Linux");
  assert.equal(deviceLabel(null), "Unknown device");
});

// ── every admin route is behind the session ──────────────────────────────────
function routes(dir = path.join(SRC, "app/api"), out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) routes(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}
/** Anything that reads or does admin things. A new route using one of these is caught below if it skips the session. */
const ADMIN_MARKERS = /\b(adminWallets|admitAdmin|moderateBoost|moderatePair|reviewApplication|moderateProfile|listProfilesForReview|listReported|getBoostStats|moderate)\(/;
/** The only admin handlers without a session: the ones that create it. */
const SIGN_IN = new Set(["admin/session:POST", "admin/nonce:POST"]);

test("every handler of every admin route requires the admin session", () => {
  const found: string[] = [];
  for (const file of routes()) {
    const rel = path.relative(path.join(SRC, "app/api"), path.dirname(file)).split(path.sep).join("/");
    const s = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    if (!ADMIN_MARKERS.test(s) && !rel.startsWith("admin")) continue;
    found.push(rel);
    assert.doesNotMatch(s, /searchParams\.get\("wallet"\)/, `${rel}: a wallet in the URL is no proof of anything`);
    const handlers = [...s.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g)];
    assert.ok(handlers.length > 0, rel);
    for (const [i, h] of handlers.entries()) {
      const body = s.slice(h.index, handlers[i + 1]?.index ?? s.length);
      if (SIGN_IN.has(`${rel}:${h[1]}`)) continue;
      // posts/mod: a creator mutes their own token with the signature alone; moderate() wants the session for anything admin
      const gated = /requireAdmin(Action)?\(req\b/.test(body) || (rel === "posts/mod" && /adminFromRequest\(req\)/.test(body) && /, session\);/.test(body));
      assert.ok(gated, `${rel} ${h[1]} does not check the admin session`);
    }
  }
  assert.deepEqual(found.sort(), ["admin/nonce", "admin/session", "boost/mod", "boost/stats", "pairs/mod", "pairs/review", "points/admin", "posts/mod", "posts/reported", "profile/admin"]);
});

test("admin actions: the session is checked before the action, against the wallet that signed it", () => {
  for (const [rel, call] of [["boost/mod", "moderateBoost("], ["pairs/mod", "moderatePair("], ["pairs/review", "reviewApplication("], ["profile/admin", "moderateProfile("], ["points/admin", "admitAdmin("]] as const) {
    const s = src(`app/api/${rel}/route.ts`);
    const post = s.slice(s.indexOf("export async function POST("));
    const gate = post.search(/requireAdminAction\(req, b\.wallet\)/);
    assert.ok(gate > 0 && gate < post.indexOf(call), `${rel}: requireAdminAction(req, b.wallet) comes before ${call}`);
    assert.doesNotMatch(post, /requireAdmin\(req/, `${rel}: an action uses the action gate`);
  }
  const s = src("lib/admin/session.ts");
  const action = s.slice(s.indexOf("export async function requireAdminAction("));
  assert.match(action, /if \(typeof signedWallet !== "string" \|\| !\/\^0x\[0-9a-fA-F\]\{40\}\$\/\.test\(signedWallet\)\) return fail\("bad wallet", 400\);/);
  assert.match(action, /if \(signedWallet\.toLowerCase\(\) !== a\.session\.wallet\) return fail\(/);
  const mod = src("lib/launchpad/postsServer.ts");
  const fn = mod.slice(mod.indexOf("export async function moderate("), mod.indexOf("const message = buildModMessage", mod.indexOf("export async function moderate(")));
  assert.match(fn, /if \(l\.launcher !== wallet && session !== wallet\) return fail\(ADMIN_SESSION_NEEDED, 401\);/, "an admin muting a token they did not launch");
  assert.match(fn, /if \(!admins\.has\(wallet\)\) return fail\("admin only", 403\);\n\s*if \(session !== wallet\) return fail\(ADMIN_SESSION_NEEDED, 401\);/, "hiding a post");
  assert.match(src("app/api/posts/mod/route.ts"), /session = fromAdminOrigin\(req\) \? \(\(await adminFromRequest\(req\)\)\?\.wallet \?\? null\) : null;/, "the session counts only from the site's own pages");
  assert.match(action, /if \(!fromAdminOrigin\(req\)\) return fail\("bad origin", 403\);/);
});

test("sign-in: same-origin, rate-limited, nonce spent only after the signature checks out", () => {
  const s = src("app/api/admin/session/route.ts");
  const post = s.slice(s.indexOf("export async function POST("), s.indexOf("export async function DELETE("));
  const order = ["fromAdminOrigin(req)", "rateLimited(`admin-signin:ip:", "checkAdminSignIn(", "adminWallets().has(c.wallet)", "adminNonceOpen(c.nonce)", "verifySig(c.wallet, [b.message as string], b.signature, \"base\")", "rateLimited(`admin-signin:wallet:", "consumeAdminNonce(c.nonce)", "createAdminSession(", "res.cookies.set(ADMIN_COOKIE, s.token, adminCookieOptions(s.expiresAt))"];
  let at = -1;
  for (const step of order) {
    const i = post.indexOf(step);
    assert.ok(i > at, `sign-in step out of order or missing: ${step}`);
    at = i;
  }
  const del = s.slice(s.indexOf("export async function DELETE("));
  assert.ok(del.indexOf("fromAdminOrigin(req)") < del.indexOf("requireAdmin(req)"));
  assert.match(del, /revokeAdminSessions\(a\.session\.wallet, all \? "all" : \{ id: id \?\? a\.session\.id \}\)/, "only this wallet's own sessions");
  assert.match(src("app/api/admin/nonce/route.ts"), /if \(!fromAdminOrigin\(req\)\) return/);
  assert.match(src("lib/admin/session.ts"), /return PROD \? \[site\] : \[site, "http:\/\/localhost:3000", "http:\/\/127\.0\.0\.1:3000"\];/, "production accepts the site alone");
});

test("the admin page renders no panel without a session", () => {
  const s = src("app/admin/page.tsx");
  const gate = s.slice(s.indexOf("if (!admin) {"), s.indexOf("  return (\n    <main className=\"mx-auto max-w-3xl"));
  assert.match(gate, /<AdminSignIn \/>/);
  for (const panel of ["AdminQueue", "ProfileQueue", "PointsAdmin", "BoostAdmin", "PairsAdmin", "PairReviewAdmin", "AdminWalletProvider"]) assert.doesNotMatch(gate, new RegExp(`<${panel}`), panel);
  assert.match(s, /<AdminWalletProvider wallet=\{admin\.wallet\}>\n\s*<AdminQueue \/>[\s\S]*<PairReviewAdmin \/>\n\s*<\/AdminWalletProvider>/);
  assert.match(s, /robots: \{ index: false, follow: false \}/);
});

test("the panels act only from the signed-in wallet and never put a wallet in a URL", () => {
  for (const f of ["components/launchpad/AdminQueue.tsx", "components/profile/ProfileQueue.tsx", "components/points/PointsAdmin.tsx", "components/launchpad/BoostAdmin.tsx", "components/launchpad/PairsAdmin.tsx", "components/launchpad/PairReviewAdmin.tsx"]) {
    const s = src(f);
    assert.match(s, /const \{ address \} = useAdminAccount\(\);/, f);
    assert.doesNotMatch(s, /useHydratedAccount/, f);
    assert.doesNotMatch(s, /\?wallet=|&wallet=/, f);
  }
  assert.match(src("components/admin/AdminAccount.tsx"), /address && admin !== null && address\.toLowerCase\(\) === admin \? address : undefined/);
});
