import { test } from "node:test";
import assert from "node:assert/strict";
import { BANNER_MAX_BYTES, IMAGE_KEY_BYTES, IMAGE_MAX_BYTES, canonicalImageUrl, checkUpload, imageRole, maxBytesFor, imageKey, imageUrlFor, isOwnImageUrl, isWalletParam, pictureKey, randomImageKey, reusedPictures, sniffImage } from "./images.ts";

const pad = (head: number[], len = 64) => new Uint8Array([...head, ...new Array(Math.max(0, len - head.length)).fill(0)]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const GIF = pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

test("sniffImage: magic bytes only — png/jpeg/webp/gif pass, svg/html/bmp/tiff/short bodies do not", () => {
  assert.equal(sniffImage(PNG), "png");
  assert.equal(sniffImage(JPEG), "jpeg");
  assert.equal(sniffImage(WEBP), "webp");
  assert.equal(sniffImage(GIF), "gif");
  assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null, "svg");
  assert.equal(sniffImage(new TextEncoder().encode("<!doctype html><html><body>hi</body></html>")), null, "html");
  assert.equal(sniffImage(pad([0x42, 0x4d])), null, "bmp");
  assert.equal(sniffImage(pad([0x49, 0x49, 0x2a, 0x00])), null, "tiff");
  assert.equal(sniffImage(pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20])), null, "riff but not webp");
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null, "too short");
  assert.equal(sniffImage(new Uint8Array(0)), null);
});

test("checkUpload: size window then type", () => {
  assert.deepEqual(checkUpload(PNG), { ok: true, kind: "png" });
  const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
  big.set(PNG.subarray(0, 8));
  const r = checkUpload(big);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 413);
  const exact = new Uint8Array(IMAGE_MAX_BYTES);
  exact.set(PNG.subarray(0, 8));
  assert.equal(checkUpload(exact).ok, true, "exactly the cap is allowed");
  const bad = checkUpload(new TextEncoder().encode("<svg/>".padEnd(64, " ")));
  assert.equal(!bad.ok && bad.status, 415);
});

test("imageKey: hex from entropy, .webp, under t/; random keys are unique and well-formed", () => {
  const rand = new Uint8Array(IMAGE_KEY_BYTES).fill(0xab);
  assert.equal(imageKey(rand), `t/${"ab".repeat(IMAGE_KEY_BYTES)}.webp`);
  assert.throws(() => imageKey(new Uint8Array(4)));
  const a = randomImageKey();
  const b = randomImageKey();
  assert.notEqual(a, b);
  assert.match(a, new RegExp(`^t/[0-9a-f]{${IMAGE_KEY_BYTES * 2}}\\.webp$`));
});

test("imageUrlFor joins without double slashes", () => {
  assert.equal(imageUrlFor("https://img.example.com/", "t/abc.webp"), "https://img.example.com/t/abc.webp");
  assert.equal(imageUrlFor("https://img.example.com", "t/abc.webp"), "https://img.example.com/t/abc.webp");
  assert.equal(imageUrlFor("http://localhost:3000/api/launch/image", "t/abc.webp"), "http://localhost:3000/api/launch/image/t/abc.webp");
});

test("isOwnImageUrl: only https, our host, our key shape — everything else stays blocked for server-side fetches", () => {
  const base = "https://openlaunch-images.fly.storage.tigris.dev";
  const key = `t/${"0".repeat(48)}.webp`;
  assert.equal(isOwnImageUrl(`${base}/${key}`, base), true);
  assert.equal(isOwnImageUrl(`${base}/${key}?x=1`, base), false, "no query");
  assert.equal(isOwnImageUrl(`${base}/${key}#f`, base), false, "no fragment");
  assert.equal(isOwnImageUrl(`${base}/other/${key}`, base), false, "wrong prefix");
  assert.equal(isOwnImageUrl(`${base}/t/abc.webp`, base), false, "wrong key shape");
  assert.equal(isOwnImageUrl(`${base}/t/${"0".repeat(48)}.svg`, base), false, "wrong extension");
  assert.equal(isOwnImageUrl(`http://openlaunch-images.fly.storage.tigris.dev/${key}`, base), false, "http");
  assert.equal(isOwnImageUrl(`https://openlaunch-images.fly.storage.tigris.dev.evil.com/${key}`, base), false, "host suffix trick");
  assert.equal(isOwnImageUrl(`https://user:pw@openlaunch-images.fly.storage.tigris.dev/${key}`, base), false, "credentials");
  assert.equal(isOwnImageUrl(`https://i.postimg.cc/${key}`, base), false, "other host");
  assert.equal(isOwnImageUrl("https://169.254.169.254/latest/meta-data", base), false, "metadata endpoint");
  assert.equal(isOwnImageUrl(`${base}/${key}`, null), false, "uploads off → nothing is ours");
  assert.equal(isOwnImageUrl(null, base), false);
  assert.equal(isOwnImageUrl("not a url", base), false);
  // local dev store base carries a path prefix
  const local = "http://localhost:3000/api/launch/image";
  assert.equal(isOwnImageUrl(`${local}/${key}`, local), false, "local base is http → never fetched server-side");
});

test("isWalletParam", () => {
  assert.equal(isWalletParam("0x" + "a".repeat(40)), true);
  assert.equal(isWalletParam("0x" + "a".repeat(39)), false);
  assert.equal(isWalletParam("abc"), false);
  assert.equal(isWalletParam(42), false);
});

test("canonicalImageUrl: legacy bucket-host URLs with our key become same-origin; everything else is untouched", () => {
  const base = "https://openlaunch.lol/api/launch/image";
  const key = `t/${"a".repeat(48)}.webp`;
  assert.equal(canonicalImageUrl(`https://openlaunch-images.fly.storage.tigris.dev/${key}`, base), `${base}/${key}`);
  assert.equal(canonicalImageUrl(`https://fly.storage.tigris.dev/openlaunch-images/${key}`, base), `${base}/${key}`);
  assert.equal(canonicalImageUrl(`${base}/${key}`, base), `${base}/${key}`, "already canonical");
  assert.equal(canonicalImageUrl("https://i.postimg.cc/abc/logo.png", base), "https://i.postimg.cc/abc/logo.png", "third-party host untouched");
  assert.equal(canonicalImageUrl("https://openlaunch-images.fly.storage.tigris.dev/t/evil.webp", base), "https://openlaunch-images.fly.storage.tigris.dev/t/evil.webp", "wrong key shape untouched");
  assert.equal(canonicalImageUrl(null, base), null);
  assert.equal(canonicalImageUrl(`https://openlaunch-images.fly.storage.tigris.dev/${key}`, null), `https://openlaunch-images.fly.storage.tigris.dev/${key}`, "uploads off → no rewrite");
  assert.equal(canonicalImageUrl("not a url", base), "not a url");
  assert.equal(isOwnImageUrl(canonicalImageUrl(`https://openlaunch-images.fly.storage.tigris.dev/${key}`, base), base), true, "canonical form passes the OG allow-list");
});

test("a banner is the only other role, and gets a larger upload cap than the logo", () => {
  assert.equal(imageRole("banner"), "banner");
  for (const v of ["logo", undefined, null, "", "Banner", "../banner"]) assert.equal(imageRole(v), "logo", String(v));
  assert.equal(maxBytesFor("logo"), IMAGE_MAX_BYTES);
  assert.equal(maxBytesFor("banner"), BANNER_MAX_BYTES);
  assert.ok(BANNER_MAX_BYTES > IMAGE_MAX_BYTES);
  const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
  big.set(PNG.slice(0, 8));
  assert.equal(checkUpload(big).ok, false, "over the logo cap");
  assert.equal(checkUpload(big, BANNER_MAX_BYTES).ok, true, "within the banner cap");
});

const KEY = `t/${"ab".repeat(24)}.webp`;
test("pictureKey finds our key in any URL that points at it and nothing else", () => {
  assert.equal(pictureKey(`https://openlaunch.lol/api/launch/image/${KEY}`), KEY);
  assert.equal(pictureKey(`https://old.example/img/${KEY}?x=1#y`), KEY, "another host, a query and a fragment");
  assert.equal(pictureKey(`https://x/${KEY.toUpperCase().replace("T/", "t/").replace(".WEBP", ".webp")}`), KEY, "upper-case hex is the same key");
  for (const no of [null, undefined, "", "https://x/a.png", `https://x/${KEY}.png`, `https://x/${KEY}x`, `https://x/t/${"ab".repeat(23)}.webp`, "https://avatars.githubusercontent.com/u/1"]) assert.equal(pictureKey(no), null, String(no));
});

test("a picture belongs to the first token that registered it: the same key on a later token is a copy", () => {
  const tok = (n: number) => "0x" + n.toString(16).padStart(40, "0");
  const url = `https://openlaunch.lol/api/launch/image/${KEY}`;
  const other = `https://openlaunch.lol/api/launch/image/t/${"cd".repeat(24)}.webp`;
  const all = [
    { chain_id: 8453, token: tok(2), created_at: "2026-10-07T10:00:05Z", image_url: url },
    { chain_id: 8453, token: tok(1), created_at: new Date("2026-10-07T10:00:00Z"), image_url: `${url}?v=2` },
    { chain_id: 8453, token: tok(3), created_at: "2026-10-07T10:00:09Z", image_url: other },
    { chain_id: 4663, token: tok(4), created_at: "2026-10-07T10:00:09Z", image_url: null },
  ];
  const rows = all.map(({ chain_id, token, image_url }) => ({ chain_id, token, image_url }));
  assert.deepEqual([...reusedPictures(rows, all)], [`8453:${tok(2)}`], "tok(1) registered it first; tok(2) copied it; the others have their own or none");
  // a tie goes to the lower address, whatever order the rows arrive in
  const tie = [{ chain_id: 8453, token: tok(9), created_at: "2026-10-07T10:00:00Z", image_url: url }, { chain_id: 8453, token: tok(7), created_at: "2026-10-07T10:00:00Z", image_url: url }];
  assert.deepEqual([...reusedPictures(tie, tie)], [`8453:${tok(9)}`]);
  assert.deepEqual([...reusedPictures(tie, [...tie].reverse())], [`8453:${tok(9)}`]);
  // an unreadable date is never "first" over a real one, and the same token is never a copy of itself
  const bad = [{ chain_id: 1, token: tok(5), created_at: "not a date", image_url: url }, { chain_id: 1, token: tok(6), created_at: "2026-10-07T10:00:00Z", image_url: url }];
  assert.deepEqual([...reusedPictures(bad, bad)], [`1:${tok(5)}`]);
  assert.equal(reusedPictures([bad[1]], [bad[1]]).size, 0);
  assert.equal(reusedPictures([], all).size, 0);
});
