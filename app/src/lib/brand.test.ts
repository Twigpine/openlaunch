import assert from "node:assert/strict";
import test from "node:test";
import { BRAND, BRAND_DOMAIN, BRAND_X, SITE_DESCRIPTION, SITE_TITLE, SOCIAL_DESCRIPTION } from "./brand.ts";

// Surface limits documented in brand.ts; the title leads with the bare brand word (the query to win).
test("site title leads with the brand word and fits Google's title width", () => {
  assert.ok(SITE_TITLE.startsWith(`${BRAND}:`), `title must start with "${BRAND}:"`);
  assert.ok(SITE_TITLE.length <= 60, `title is ${SITE_TITLE.length} chars`);
  assert.ok(SITE_DESCRIPTION.length <= 155, `description is ${SITE_DESCRIPTION.length} chars`);
  assert.ok(SOCIAL_DESCRIPTION.length <= 125, `social description is ${SOCIAL_DESCRIPTION.length} chars`);
});

test("brand constants never point at the squatted look-alikes", () => {
  assert.equal(BRAND_DOMAIN, "openlaunch.lol");
  assert.equal(BRAND_X, "openlaunch_lol");
});
