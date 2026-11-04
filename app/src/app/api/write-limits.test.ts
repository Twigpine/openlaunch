import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

/** Every route.ts below this directory, recursively. */
function routeFiles(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    return entry.isDirectory() ? routeFiles(child) : entry.name === "route.ts" ? [child] : [];
  });
}

for (
  const { file, bucket, mustPrecede } of [
    { file: "./launch/sync/route.ts", bucket: "sync:ip", mustPrecede: "pollAll()" },
    { file: "./launch/meta/route.ts", bucket: "meta:ip", mustPrecede: "readJson(req, 8_192)" },
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

test("no route trusts the client-controlled first x-forwarded-for entry", () => {
  for (const file of routeFiles(new URL(".", import.meta.url))) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(
      src,
      /x-forwarded-for[\s\S]{0,160}?split\(","\)\[0\]/,
      `${file.pathname} must use clientIp() instead of the first XFF entry`,
    );
  }
});

test("the JSON write routes cap the body before parsing it", () => {
  for (const { file, cap } of [
    { file: "./launch/edit/route.ts", cap: "16_384" },
    { file: "./launch/edit/nonce/route.ts", cap: "2_048" },
    { file: "./launch/meta/route.ts", cap: "8_192" },
    { file: "./posts/route.ts", cap: "4_096" },
    { file: "./posts/mod/route.ts", cap: "2_048" },
    { file: "./posts/report/route.ts", cap: "2_048" },
  ]) {
    const src = source(file);
    assert.doesNotMatch(src, /await req\.json\(\)/, `${file} must not buffer an unbounded JSON body`);
    assert.ok(src.includes(`readJson(req, ${cap})`), `${file} must use readJson(req, ${cap})`);
  }
});

test("the RPC proxy caps its request and response, and its token bucket is bounded without a clear-all", () => {
  const src = source("./rpc/route.ts");
  assert.match(src, /readJsonValue\(req, MAX_BODY_BYTES\)/);
  assert.match(src, /readTextLimited\(res, MAX_RESPONSE_BYTES\)/);
  assert.match(src, /takeToken\(ip, BUCKET_CAP, BUCKET_REFILL_PER_S\)/);
  assert.doesNotMatch(src, /buckets\.clear/);
});

test("the image upload caps chunked multipart bodies too", () => {
  const src = source("./launch/image/route.ts");
  assert.match(src, /readFormData\(req, BANNER_MAX_BYTES \+ 16 \* 1024\)/);
  assert.doesNotMatch(src, /req\.formData\(\)/);
});

test("sync never returns the raw viem message, which can carry the keyed RPC URL", () => {
  const src = source("./launch/sync/route.ts");
  assert.match(src, /redactUrls\(/);
  assert.match(src, /const safe = Object\.fromEntries\(/);
  assert.match(src, /reason: redactUrls\(result\.reason\)/);
  // the response copy must not mutate a shared single-flight poll result
  assert.doesNotMatch(src, /r\.reason = redactUrls\(/);
  assert.doesNotMatch(src, /error: err instanceof Error \? err\.message/);
});
