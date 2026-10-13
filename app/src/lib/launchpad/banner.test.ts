import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contracts for token banners: one optional image beside the logo, stored and validated like it, signed like
 * every other edit, and shown on the market cards and the token page. The rules themselves are unit-tested in
 * images.test.ts, imageProcess.test.ts, metaShared.test.ts and creator.test.ts.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const schema = read("../../../db/schema.sql");
const route = read("../../app/api/launch/image/route.ts");
const meta = read("./meta.ts");
const editServer = read("./editServer.ts");
const queries = read("./queries.ts");
const form = read("../../components/launchpad/LaunchForm.tsx");
const sheet = read("../../components/launchpad/EditTokenSheet.tsx");
const card = read("../../components/launchpad/LaunchCard.tsx");
const page = read("../../app/t/[chain]/[token]/page.tsx");

test("the banner is one nullable column, added idempotently", () => {
  assert.match(schema, /ALTER TABLE bb_launch_meta ADD COLUMN IF NOT EXISTS banner_url text;/);
});

test("uploads pick the processor and the byte cap from the role; everything else is the logo's path", () => {
  assert.match(route, /const role = imageRole\(form\.get\("kind"\)\);/);
  assert.match(route, /const pre = checkUpload\(bytes, max\);/);
  assert.match(route, /out = role === "banner" \? await toBannerWebp\(bytes\) : await toLogoWebp\(bytes\);/);
  assert.match(route, /await putImage\(randomImageKey\(\), out\)/, "a random key in the same store, never a user-chosen name");
});

test("the banner is saved at launch, replaced by signed edits, and read with the market list", () => {
  assert.match(meta, /INSERT INTO bb_launch_meta \(chain_id, token, launcher, meta_key, name, symbol, description, image_url, banner_url, website, x_handle\)/);
  assert.match(editServer, /banner_url = EXCLUDED\.banner_url/);
  assert.match(queries, /m\.image_url, m\.banner_url, m\.website/);
  assert.match(queries, /banner_url: canonicalImageUrl\(r\.banner_url, imagePublicBase\(\)\),/);
});

test("the launch form and the edit sheet offer it; the cards and the token page show it", () => {
  assert.match(form, /banner_url: banner,/);
  assert.match(form, /<ImageUpload kind="banner" value=\{banner\} onChange=\{setBanner\}/);
  assert.match(sheet, /<ImageUpload kind="banner" value=\{f\.banner_url \?\? ""\}/);
  assert.match(card, /<Banner token=\{l\.token\} image=\{l\.image_url\} banner=\{l\.banner_url\} \/>/);
  // the page's hero wears the card's own cover, so a banner shows the same way on both (and falls back the same way)
  assert.match(page, /<Banner token=\{l\.token\} image=\{l\.image_url\} banner=\{l\.banner_url\} \/>/);
});
