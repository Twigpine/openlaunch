import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPointsAdminMessage, normalizeSeasonDays } from "./auth.ts";

const base = { wallet: "0xAbC0000000000000000000000000000000000001", nonce: "a".repeat(32), ts: 1_760_000_000_000 };

test("starting a season signs its length: another length is another message", () => {
  const m28 = buildPointsAdminMessage({ ...base, action: "start", days: 28 });
  assert.match(m28, /Season length: 28 days/);
  assert.notEqual(buildPointsAdminMessage({ ...base, action: "start", days: 1 }), m28, "a request changed to 1 day no longer matches the signature");
});

test("the length is normalized the same way on both sides (1 to 90 whole days, 28 by default)", () => {
  assert.equal(normalizeSeasonDays(undefined), 28);
  assert.equal(normalizeSeasonDays("abc"), 28);
  assert.equal(normalizeSeasonDays(0), 28);
  assert.equal(normalizeSeasonDays(500), 90);
  assert.equal(normalizeSeasonDays(-3), 1);
  assert.equal(normalizeSeasonDays("14.9"), 14);
  assert.equal(buildPointsAdminMessage({ ...base, action: "start", days: 500 }), buildPointsAdminMessage({ ...base, action: "start", days: 90 }));
});

test("other actions carry no length line", () => {
  for (const action of ["preview", "publish", "unpublish", "end", "recompute"] as const) {
    assert.doesNotMatch(buildPointsAdminMessage({ ...base, action, days: 5 }), /Season length/, action);
  }
});
