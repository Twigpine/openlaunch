import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sanitizeDigest } from "./error-copy.ts";
import { en, messagesFor } from "../i18n/messages/index.ts";

test("sanitizeDigest keeps short opaque ids and drops markup", () => {
  assert.equal(sanitizeDigest("abc123"), "abc123");
  assert.equal(sanitizeDigest("  aBc-12_34  "), "aBc-12_34");
  assert.equal(sanitizeDigest(undefined), null);
  assert.equal(sanitizeDigest(null), null);
  assert.equal(sanitizeDigest(""), null);
  assert.equal(sanitizeDigest("   "), null);
  assert.equal(sanitizeDigest(123), null);
  assert.equal(sanitizeDigest("</script>"), null);
  assert.equal(sanitizeDigest("<img src=x onerror=alert(1)>"), null);
  assert.equal(sanitizeDigest("digest with spaces"), null);
  assert.equal(sanitizeDigest("a".repeat(64)), "a".repeat(64));
  assert.equal(sanitizeDigest("a".repeat(65)), null);
});

test("copy stays factual per page kind", () => {
  assert.equal(en.info.errors.route, "Something broke on this page. Your funds are on-chain; this is only the site.");
  assert.equal(en.info.errors.global, "Something broke. Your funds are on-chain; this is only the site.");
  assert.equal(en.info.errors.notFound, "Nothing here. The page you asked for does not exist.");
  assert.equal(en.info.errors.pageError, "Page error");
  assert.equal(en.info.errors.pageNotFound, "Page not found");
});

const routeError = readFileSync(new URL("../app/error.tsx", import.meta.url), "utf8");
const globalError = readFileSync(new URL("../app/global-error.tsx", import.meta.url), "utf8");
const notFound = readFileSync(new URL("../app/not-found.tsx", import.meta.url), "utf8");

// Source contracts: Next.js injects `{ error, reset }` into error boundaries.
// A `retry` prop is never provided, so the button must call `reset`.
test("route + global error boundaries use the Next.js reset prop (not retry)", () => {
  for (const [name, src] of [["error.tsx", routeError], ["global-error.tsx", globalError]] as const) {
    assert.match(src, /reset: \(\) => void/, `${name} declares the reset prop`);
    assert.match(src, /onClick=\{reset\}/, `${name} wires Try again to reset`);
    assert.doesNotMatch(src, /\bretry\b/, `${name} has no leftover retry prop`);
  }
});

test("error boundaries expose an alert landmark, a real heading, and a safe digest", () => {
  for (const [name, src] of [["error.tsx", routeError], ["global-error.tsx", globalError]] as const) {
    assert.match(src, /<h1/, `${name} renders the status as a heading`);
    assert.match(src, /role="alert"/, `${name} announces the failure to assistive tech`);
    assert.match(src, /aria-label=\{t\("pageError"\)\}/, `${name} labels the landmark`);
    assert.match(src, /sanitizeDigest\(error\.digest\)/, `${name} renders the digest only when safe`);
    assert.match(src, /t\("errorId", \{ digest \}\)/, `${name} shows the digest id for support`);
  }
  assert.equal(en.info.errors.errorId, "Error ID: {digest}");
  assert.match(routeError, /t\("route"\)/, "route copy comes from the messages");
  assert.match(globalError, /t\("global"\)/, "global copy comes from the messages");
  for (const kind of ["route", "global"] as const) assert.match(messagesFor("zh-CN").info.errors[kind], /你的资金在链上/, `${kind}: the funds are on-chain, in Chinese too`);
});

test("the root error page picks its language from the switcher's cookie, outside the layout's provider", () => {
  assert.match(globalError, /document\.cookie/);
  assert.match(globalError, /LOCALE_COOKIE/);
  assert.match(globalError, /useSyncExternalStore\(unchanging, savedLocale, serverLocale\)/, "English on the server and while hydrating");
  assert.match(globalError, /<html lang=\{locale\}/);
  assert.match(globalError, /import\("@\/i18n\/messages\/zh-CN"\)/, "Chinese loads only for a Chinese reader");
});

test("404 stays generic with heading semantics and two ways back", () => {
  assert.match(notFound, /<h1/, "404 renders as a heading, not a div");
  assert.match(notFound, /aria-label=\{t\("errors\.pageNotFound"\)\}/, "404 landmark is labelled");
  assert.match(notFound, /t\("errors\.notFound"\)/, "404 copy comes from the messages");
  assert.doesNotMatch(en.info.errors.notFound + messagesFor("zh-CN").info.errors.notFound, /token|代币/i, "404 stays generic in either language");
  assert.doesNotMatch(notFound, /That token has not been launched here/, "404 no longer claims every bad URL is a token");
  assert.ok(notFound.includes('href="/"'), "404 links home");
  assert.ok(notFound.includes('href="/launch"'), "404 links to the launch flow");
});
