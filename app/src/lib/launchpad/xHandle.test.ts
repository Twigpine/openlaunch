import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseXHandle } from "./xHandle.ts";

const handle = (input: unknown) => {
  const r = parseXHandle(input);
  return r.ok ? r.handle : null;
};

test("parseXHandle: a bare handle, with or without @, surrounding space trimmed", () => {
  assert.equal(handle("foo"), "foo");
  assert.equal(handle("@foo_1"), "foo_1");
  assert.equal(handle("  @Foo  "), "Foo", "case is kept as typed");
  assert.equal(handle("a".repeat(15)), "a".repeat(15));
});

test("parseXHandle: empty and non-string input mean no handle, not an error", () => {
  assert.equal(handle(""), "");
  assert.equal(handle("   "), "");
  assert.equal(handle(undefined), "");
  assert.equal(handle(null), "");
  assert.equal(handle(42), "");
});

test("parseXHandle: profile links on x.com and twitter.com, as pasted from the app", () => {
  for (const link of [
    "https://x.com/foo",
    "http://x.com/foo",
    "x.com/foo",
    "https://www.x.com/foo",
    "https://mobile.x.com/foo",
    "https://twitter.com/foo",
    "www.twitter.com/foo",
    "https://mobile.twitter.com/foo",
    "HTTPS://X.COM/foo",
    "https://x.com/foo/",
    "https://x.com/foo?s=21&t=abc",
    "https://x.com/foo#top",
    "https://x.com/foo/status/1234567890",
    "https://x.com/@foo",
  ]) assert.equal(handle(link), "foo", link);
});

test("parseXHandle: other hosts, lookalikes and non-web schemes are rejected", () => {
  for (const bad of [
    "https://evil.com/foo",
    "https://x.com.evil.com/foo",
    "https://notx.com/foo",
    "https://x.com@evil.com/foo",
    "https://t.co/foo",
    "javascript://x.com/foo",
    "ftp://x.com/foo",
  ]) assert.equal(handle(bad), null, bad);
});

test("parseXHandle: links that are not a profile are rejected", () => {
  for (const bad of ["https://x.com", "https://x.com/", "x.com", "https://x.com/home", "https://x.com/i/communities/1", "https://x.com/Intent/post?text=hi", "x.com/search?q=foo"]) {
    assert.equal(handle(bad), null, bad);
  }
});

// Every handle the old validators accepted must still pass, or a saved token's edit sheet would refuse to open clean.
test("parseXHandle: the page list applies to links only; a typed handle is never second-guessed", () => {
  for (const ok of ["home", "@share", "i", "Search", "_", "a_b_c_d_e_f_g_h"]) assert.equal(handle(ok), ok.replace(/^@/, ""), ok);
});

test("parseXHandle: tricks that try to smuggle another host past the check", () => {
  for (const bad of ["https://x.com\\@evil.com/foo", "https://x.com%2F@evil.com/foo", "https://evil.com/x.com/foo", "https://evil.com#x.com/foo", "https://x.com:8443@evil.com/foo", "//evil.com/foo", "https://x.com/%66oo", "https://x.com/foo bar"]) {
    assert.equal(handle(bad), null, bad);
  }
});

test("parseXHandle: bad handles are rejected, never silently truncated", () => {
  assert.equal(handle("bad handle!"), null);
  assert.equal(handle("a".repeat(16)), null, "16 characters");
  assert.equal(handle(`https://x.com/${"a".repeat(16)}`), null);
  assert.equal(handle("foo-bar"), null);
  assert.equal(handle("<script>"), null);
  assert.equal(handle(`https://x.com/foo?${"a".repeat(300)}`), null, "oversized input");
});

// Source contracts: both forms route the field through the shared parser and say what it accepts.
test("the launch form and the edit sheet accept a link in the X field", () => {
  const launch = readFileSync(new URL("../../components/launchpad/LaunchForm.tsx", import.meta.url), "utf8");
  const edit = readFileSync(new URL("../../components/launchpad/EditTokenSheet.tsx", import.meta.url), "utf8");
  assert.match(launch, /const xParsed = parseXHandle\(x\);/);
  assert.match(launch, /if \(!xParsed\.ok\) errors\.push\("X: enter a handle or an x\.com link\."\);/);
  for (const form of [launch, edit]) {
    assert.match(form, /placeholder="@handle or x\.com link"/);
    assert.doesNotMatch(form, /placeholder="@handle"/);
  }
});
