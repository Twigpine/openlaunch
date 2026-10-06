import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SECURITY_HEADERS, WALLET_CONNECT_SRC, buildCsp, cspNonce, extraConnectOrigins, isOrigin } from "./security-headers.ts";

const NONCE = "AAAAAAAAAAAAAAAAAAAAAA==";

function directive(csp: string, name: string): string {
  const found = csp.split("; ").find((d) => d.startsWith(`${name} `) || d === name);
  assert.ok(found, `missing directive ${name}`);
  return found;
}

test("cspNonce base64-encodes at least 16 random bytes", () => {
  assert.equal(cspNonce(new Uint8Array(16)), NONCE);
  assert.match(cspNonce(new Uint8Array(32).fill(255)), /^[A-Za-z0-9+/]+={0,2}$/);
  assert.throws(() => cspNonce(new Uint8Array(8)), /16 random bytes/);
});

test("production policy: nonce-only scripts, deny embedding this site, exact hosted-chart origin", () => {
  const csp = buildCsp(NONCE);
  assert.equal(directive(csp, "default-src"), "default-src 'self'");
  assert.equal(directive(csp, "script-src"), `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`);
  assert.doesNotMatch(directive(csp, "script-src"), /unsafe-inline|unsafe-eval/);
  assert.equal(directive(csp, "frame-ancestors"), "frame-ancestors 'none'");
  assert.equal(directive(csp, "frame-src"), "frame-src https://www.geckoterminal.com");
  assert.equal(directive(csp, "object-src"), "object-src 'none'");
  assert.equal(directive(csp, "base-uri"), "base-uri 'self'");
  assert.equal(directive(csp, "form-action"), "form-action 'self'");
  assert.equal(directive(csp, "img-src"), "img-src 'self' https: data:");
  assert.equal(directive(csp, "upgrade-insecure-requests"), "upgrade-insecure-requests");
  assert.doesNotMatch(csp, /ws:|localhost|127\.0\.0\.1/);
});

test("connect-src covers the site and the wallet SDK, plus vetted extra origins only", () => {
  const csp = buildCsp(NONCE, { connectSrc: ["http://127.0.0.1:8545", "https://openlaunch.lol", "https://evil.example/path", "javascript:alert(1)", "not a url"] });
  const connect = directive(csp, "connect-src");
  const connectSources = new Set(connect.split(/\s+/).slice(1));
  assert.ok(connect.startsWith("connect-src 'self' "));
  for (const origin of WALLET_CONNECT_SRC) assert.ok(connectSources.has(origin), `missing ${origin}`);
  assert.ok(!connectSources.has("https://rpc.mainnet.arc.io")); // Arc reads go through /api/rpc, never a third-party origin
  assert.deepEqual(extraConnectOrigins({ NEXT_PUBLIC_RPC_URL_ARC: "http://127.0.0.1:8547/" }), ["http://127.0.0.1:8547"]);
  assert.ok(!connectSources.has("https:"));
  assert.ok(connectSources.has("http://127.0.0.1:8545"));
  assert.ok(connectSources.has("https://openlaunch.lol"));
  assert.doesNotMatch(connect, /evil|javascript|not a url/);
});

test("development adds eval and HMR sockets and drops the https upgrade", () => {
  const csp = buildCsp(NONCE, { dev: true });
  assert.ok(directive(csp, "script-src").endsWith(" 'unsafe-eval'"));
  assert.match(directive(csp, "connect-src"), / ws: http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*$/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
});

test("chart frames work after client navigation without allowing provider scripts or connections in our page", () => {
  for (const dev of [false, true]) {
    const policy = buildCsp(NONCE, { dev });
    assert.equal(directive(policy, "frame-src"), "frame-src https://www.geckoterminal.com");
    assert.equal(directive(policy, "frame-ancestors"), "frame-ancestors 'none'");
    assert.doesNotMatch(directive(policy, "connect-src"), /geckoterminal/);
    assert.doesNotMatch(directive(policy, "script-src"), /geckoterminal/);
  }
});

test("a malformed nonce cannot smuggle directives into the policy", () => {
  for (const bad of ["", "short", `${NONCE}; script-src *`, "abc def ghi jkl mno", "<script>"]) {
    assert.throws(() => buildCsp(bad), /base64/, bad);
  }
});

test("isOrigin accepts bare web origins only", () => {
  for (const ok of ["https://a.b", "http://localhost:3000", "wss://relay.example", "ws://127.0.0.1:8080"]) assert.equal(isOrigin(ok), true, ok);
  for (const no of ["https://a.b/", "https://a.b/x", "https://u:p@a.b", "ftp://a.b", "data:text/html,x", "a.b", ""]) assert.equal(isOrigin(no), false, no);
});

test("extraConnectOrigins reduces env URLs to unique origins and ignores junk", () => {
  const origins = extraConnectOrigins({
    NEXT_PUBLIC_SITE_URL: "https://openlaunch.lol/",
    NEXT_PUBLIC_RPC_URL_BASE: " http://127.0.0.1:8545/rpc ",
    NEXT_PUBLIC_RPC_URL_ROBINHOOD: "http://127.0.0.1:8545",
    NEXT_PUBLIC_RPC_URL_ARC: "http://127.0.0.1:8547",
    DATABASE_URL: "postgres://localhost/openlaunch_dev",
  });
  assert.deepEqual(origins, ["https://openlaunch.lol", "http://127.0.0.1:8545", "http://127.0.0.1:8547"]);
  assert.deepEqual(extraConnectOrigins({ NEXT_PUBLIC_RPC_URL_BASE: "nope" }), []);
  assert.deepEqual(extraConnectOrigins({}), []);
});

test("static headers deny framing, sniffing, and plain-http return visits", () => {
  const byKey = Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key, h.value]));
  assert.equal(byKey["x-frame-options"], "DENY");
  assert.equal(byKey["x-content-type-options"], "nosniff");
  assert.equal(byKey["referrer-policy"], "strict-origin-when-cross-origin");
  assert.match(byKey["strict-transport-security"], /^max-age=\d{8,}; includeSubDomains$/);
  assert.match(byKey["permissions-policy"], /camera=\(\)/);
  // Wallet popups need window.opener; never send a COOP that severs it.
  assert.equal(byKey["cross-origin-opener-policy"], undefined);
});

// Source contracts: the policy only protects if every hop forwards the same nonce.
const proxy = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
const themeProvider = readFileSync(new URL("../components/ThemeProvider.tsx", import.meta.url), "utf8");
const nextConfig = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");

test("proxy mints a random nonce and sets the policy on the request and the response", () => {
  assert.match(proxy, /cspNonce\(crypto\.getRandomValues\(new Uint8Array\(16\)\)\)/);
  assert.match(proxy, /headers\.set\("x-nonce", nonce\)/);
  assert.match(proxy, /headers\.set\("content-security-policy", csp\)/);
  assert.match(proxy, /NextResponse\.next\(\{ request: \{ headers \} \}\)/);
  assert.match(proxy, /res\.headers\.set\("content-security-policy", csp\)/);
  assert.match(proxy, /const DEV = process\.env\.NODE_ENV === "development"/);
  assert.match(proxy, /dev: DEV/);
  // Literal env reads, so the build inlines the same values browserRpc() bakes into the client.
  for (const key of ["NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_RPC_URL_BASE", "NEXT_PUBLIC_RPC_URL_ROBINHOOD", "NEXT_PUBLIC_RPC_URL_ARC"]) {
    assert.match(proxy, new RegExp(`${key}: process\\.env\\.${key}`));
  }
  assert.doesNotMatch(proxy, /extraConnectOrigins\(process\.env\)/);
});

test("the root layout forwards the request nonce to next-themes' inline script", () => {
  assert.match(layout, /import \{ headers \} from "next\/headers"/);
  assert.match(layout, /\(await headers\(\)\)\.get\("x-nonce"\)/);
  assert.match(layout, /<ThemeProvider nonce=\{nonce\}>/);
  assert.match(themeProvider, /nonce\?: string/);
  assert.match(themeProvider, /<NextThemes[^>]*nonce=\{nonce\}/);
});

test("next.config applies the static headers to every route", () => {
  assert.match(nextConfig, /import \{ SECURITY_HEADERS \} from "\.\/src\/lib\/security-headers"/);
  assert.match(nextConfig, /source: "\/\(\.\*\)",\s*headers: \[\.\.\.SECURITY_HEADERS\]/);
});
