import { test } from "node:test";
import assert from "node:assert/strict";
import { safeSocials } from "./socials.ts";

test("an https website and a bare handle become links, with a short host to show", () => {
  assert.deepEqual(safeSocials({ website: "https://www.dottie.land/about", x_handle: "dottie_land" }), { x: "dottie_land", site: "https://www.dottie.land/about", host: "dottie.land" });
});

test("anything else is dropped rather than linked", () => {
  for (const website of ["http://dottie.land", "javascript:alert(1)", "ftp://dottie.land", "not a url", "https://user:pass@dottie.land", ""]) {
    assert.equal(safeSocials({ website, x_handle: null }).site, null, website);
  }
  for (const x_handle of ["@dottie", "dottie land", "a".repeat(16), "dottie/land", ""]) {
    assert.equal(safeSocials({ website: null, x_handle }).x, null, x_handle);
  }
  assert.deepEqual(safeSocials({ website: null, x_handle: null }), { x: null, site: null, host: null });
});
