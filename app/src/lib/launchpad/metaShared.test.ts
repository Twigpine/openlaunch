import { test } from "node:test";
import assert from "node:assert/strict";
import { metaUriFor, metaWriteDecision, validateMeta } from "./metaShared.ts";

const L = "0x00000000000000000000000000000000000c0ffe";
const SALT = "0x" + "a".repeat(64);
const KEY = "0x" + "B".repeat(64);
const base = { chain: "base" as const, launcher: L, salt: SALT, name: "Clear Sky", symbol: "sky" };

test("validateMeta: meta_key is optional (defaults to the salt) and normalized to lowercase", () => {
  const a = validateMeta(base);
  assert.ok(a.ok);
  assert.equal(a.ok && a.value.meta_key, SALT);
  const b = validateMeta({ ...base, meta_key: KEY });
  assert.ok(b.ok);
  assert.equal(b.ok && b.value.meta_key, KEY.toLowerCase());
  assert.equal(b.ok && b.value.symbol, "SKY");
  assert.equal(validateMeta({ ...base, meta_key: "0x1234" }).ok, false, "bad key rejected");
  assert.equal(validateMeta({ ...base, salt: "nope" }).ok, false);
  assert.equal(validateMeta({ ...base, image_url: "http://x.y/z.png" }).ok, false, "https only");
});

test("metaUriFor is keyed by (launcher, meta_key) and is stable while the salt changes", () => {
  const u1 = metaUriFor(L, KEY);
  assert.match(u1, /\/api\/launch\/meta\/0x00000000000000000000000000000000000c0ffe\/0xbbbb/);
  assert.equal(metaUriFor(L.toLowerCase(), KEY.toLowerCase()), u1, "case-insensitive");
  assert.notEqual(metaUriFor(L, SALT), u1, "a different key → different URI");
});

test("metaWriteDecision: insert when new, same on an identical resend, conflict on any change", () => {
  const v = validateMeta({ ...base, description: "gm", website: "https://sky.xyz" });
  assert.ok(v.ok);
  const inc = v.ok ? v.value : (null as never);
  assert.equal(metaWriteDecision(null, inc), "insert");
  const row = { launcher: L.toLowerCase(), name: "Clear Sky", symbol: "SKY", description: "gm", image_url: null, website: "https://sky.xyz/", x_handle: null };
  assert.equal(metaWriteDecision(row, inc), "same", "identical resend is idempotent");
  assert.equal(metaWriteDecision({ ...row, description: "rug incoming" }, inc), "conflict", "changed description");
  assert.equal(metaWriteDecision({ ...row, launcher: "0x" + "1".repeat(40) }, inc), "conflict", "different launcher");
  assert.equal(metaWriteDecision({ ...row, image_url: "https://evil/x.png" }, inc), "conflict", "attacker image");
});

test("validateMeta: x_handle takes a handle or an x.com link and stores the bare handle", () => {
  const link = validateMeta({ ...base, x_handle: "https://twitter.com/clear_sky/status/1" });
  const bare = validateMeta({ ...base, x_handle: "@clear_sky" });
  assert.ok(link.ok && bare.ok);
  assert.equal(link.ok && link.value.x_handle, "clear_sky");
  assert.equal(validateMeta(base).ok && (validateMeta(base) as { value: { x_handle?: string } }).value.x_handle, undefined, "empty stays unset");
  assert.equal(validateMeta({ ...base, x_handle: "https://evil.com/clear_sky" }).ok, false, "other hosts rejected");
  assert.equal(validateMeta({ ...base, x_handle: "a".repeat(16) }).ok, false, "too long is an error, not a truncation");
  // a retry that sends the link again matches the row saved from it (and from the bare handle)
  const row = { launcher: L.toLowerCase(), name: "Clear Sky", symbol: "SKY", description: null, image_url: null, website: null, x_handle: "clear_sky" };
  if (link.ok && bare.ok) {
    assert.equal(metaWriteDecision(row, link.value), "same");
    assert.equal(metaWriteDecision(row, bare.value), "same");
  }
});
