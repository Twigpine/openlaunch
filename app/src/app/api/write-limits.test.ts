import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Pin the per-IP rate-limit wiring on the unauthenticated write endpoints.
 * The limiter behavior itself is unit-tested in editServer.test.ts; these
 * assertions fail if anyone drops the check from a route (the same
 * source-structural pattern as the preparing-controls test in
 * transaction-safety.test.ts, since importing Next routes into node --test
 * is not supported).
 */
function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
}

for (
  const { file, bucket, mustPrecede } of [
    { file: "./launch/sync/route.ts", bucket: "sync:ip", mustPrecede: "pollAll()" },
    { file: "./launch/meta/route.ts", bucket: "meta:ip", mustPrecede: "req.json()" },
    { file: "./presence/route.ts", bucket: "presence:ip", mustPrecede: "recordBeacon(" },
    { file: "./boost/seen/route.ts", bucket: "boost-seen:ip", mustPrecede: "readJson(" },
  ]
) {
  test(`${file} rate-limits by IP before doing work`, () => {
    const src = source(file);
    assert.match(src, /from "@\/lib\/launchpad\/editServer"/, "imports the shared limiter");
    assert.ok(src.includes("rateLimited(`" + bucket + ":${ip}`"), `calls rateLimited with a ${bucket} key`);
    assert.match(src, /\{\s*error:\s*"slow down"\s*\},\s*\{\s*status:\s*429\s*\}/, "answers 429 like the sibling write routes");
    assert.ok(
      src.indexOf("rateLimited(`" + bucket) < src.indexOf(mustPrecede),
      `the limit runs before ${mustPrecede}`,
    );
  });
}

test("presence still short-circuits bots before counting the bucket", () => {
  const src = source("./presence/route.ts");
  assert.ok(src.indexOf("looksLikeBot(ua)") < src.indexOf("rateLimited(`presence:ip"), "bot beacons never touch the limiter or the DB");
});

test("sync still validates tx/chain shapes with 400s", () => {
  const src = source("./launch/sync/route.ts");
  assert.match(src, /\{\s*error:\s*"bad tx"\s*\},\s*\{\s*status:\s*400\s*\}/);
  assert.match(src, /\{\s*error:\s*"bad chain"\s*\},\s*\{\s*status:\s*400\s*\}/);
});

test("the Boosted lane beacon skips bots before the limiter, and caps its body", () => {
  const src = source("./boost/seen/route.ts");
  assert.ok(src.indexOf("looksLikeBot(ua)") < src.indexOf("rateLimited(`boost-seen:ip"), "bot beacons never touch the limiter or the DB");
  // another site's beacons are refused before they use a bucket or reach the DB
  assert.match(src, /if \(!boostBeaconSameOrigin\(req\.headers\.get\("sec-fetch-site"\), req\.headers\.get\("origin"\), req\.headers\.get\("host"\)\)\) \{\n\s*return NextResponse\.json\(\{ error: "cross-site" \}, \{ status: 403 \}\);/);
  assert.ok(src.indexOf("boostBeaconSameOrigin(req") < src.indexOf("rateLimited(`boost-seen:ip"));
  assert.ok(src.indexOf("rateLimited(`boost-seen:ip") < src.indexOf("recordBoostSeen("));
  assert.match(src, /parseBoostSeen\(await readJson\(req, 512\)\)/);
});
