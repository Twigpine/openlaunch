import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeBot, visitorHash } from "./presence.ts";

test("bot beacons skip the write path without minting visits", () => {
  for (const ua of ["Googlebot/2.1", "curl/8.0", "python-requests/2.31", "axios/1.0", "Lighthouse"]) assert.equal(looksLikeBot(ua), true, ua);
  assert.equal(looksLikeBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"), false);
  assert.equal(looksLikeBot(""), false);
});

test("visitor hashes are opaque 64-hex and differ per visitor", () => {
  const a = visitorHash("1.2.3.4", "Mozilla/5.0");
  const b = visitorHash("5.6.7.8", "Mozilla/5.0");
  const c = visitorHash("1.2.3.4", "curl/8.0");
  for (const h of [a, b, c]) assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b, "different IPs differ");
  assert.notEqual(a, c, "different UAs differ");
  assert.equal(a, visitorHash("1.2.3.4", "Mozilla/5.0"), "stable within the day");
});
