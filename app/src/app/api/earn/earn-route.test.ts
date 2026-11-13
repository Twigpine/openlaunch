import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Source contract, like write-limits.test.ts: the route is read as text, not run.
const src = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("the per-IP limit runs before anything else", () => {
  const limit = src.indexOf("rateLimited(`earn:ip:");
  assert.ok(limit > 0);
  assert.ok(limit < src.indexOf("earnEnabled()"));
  assert.ok(limit < src.indexOf("earnInfo()"));
});

test("switched off, the answer is exactly { enabled: false } and nothing is read", () => {
  assert.match(src, /if \(!earnEnabled\(\)\) return NextResponse\.json\(\{ enabled: false \}/);
  assert.ok(src.indexOf("if (!earnEnabled())") < src.indexOf("await earnInfo()"));
});

test("the route never takes a wallet and is never cached", () => {
  assert.doesNotMatch(src, /searchParams|req\.url|req\.json|req\.body/);
  assert.match(src, /export const dynamic = "force-dynamic"/);
  assert.match(src, /"cache-control": "no-store"/);
});
