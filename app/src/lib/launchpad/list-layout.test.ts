import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_COOKIE, layoutCookie, parseLayout } from "./list-layout.ts";

test("only an exact cards value picks cards; anything else is the row list", () => {
  assert.equal(parseLayout("cards"), "cards");
  assert.equal(parseLayout("list"), "list");
  for (const value of [undefined, null, "", "Cards", "grid", "cards;"]) assert.equal(parseLayout(value), "list", String(value));
});

test("the cookie lasts a year, covers the whole site and stays first-party", () => {
  const cookie = layoutCookie("cards");
  assert.ok(cookie.startsWith(`${LAYOUT_COOKIE}=cards;`));
  assert.match(cookie, /; path=\/;/);
  assert.match(cookie, /max-age=31536000/);
  assert.match(cookie, /samesite=lax/);
});
