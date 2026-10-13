import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contracts for how the home board survives a failing list: Volume with a window once answered 502, and the
 * whole page unmounted. A failed read now stays inline, offers a retry, and picking a view never re-renders the page on the server.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const list = read("./LaunchList.tsx");
const live = read("./LiveProvider.tsx");

test("a non-OK list or live response is caught, never thrown into render", () => {
  const selection = list.slice(list.indexOf("function loadSelection"), list.indexOf("const nq = normalizeQuery(q);"));
  assert.match(selection, /if \(!res\.ok\) throw new Error\("List unavailable"\);/);
  assert.match(selection, /\.catch\(\(\) => \{[^\n]*setLoadError\(/, "the rejection lands in the inline error");
  assert.match(live, /if \(!res\.ok\) return;/, "the shared poll keeps the last snapshot");
  assert.match(live, /catch \{\s*\/\* offline; keep last \*\//);
});

test("the inline error is an alert with a retry for both a failed view and a failed page", () => {
  assert.match(list, /<p role="alert"[^\n]*\n[^\n]*loadError/);
  assert.match(list, /failedLoad\.current === "more" \? loadMore\(\) : loadSelection\(selectionRef\.current\)/);
  assert.match(list, />Try again<\/button>/);
  assert.match(list, /failedLoad\.current = "view"/);
  assert.match(list, /failedLoad\.current = "more"/);
});

test("on the home page a selection changes the address only; it does not navigate through the server", () => {
  const sync = list.slice(list.indexOf("function syncUrl"), list.indexOf("function pick("));
  assert.match(sync, /window\.location\.pathname === "\/"\) window\.history\.replaceState\(null, "", href\)/);
  assert.match(sync, /else router\.replace\(href/, "a chain page still hands over to the home page");
});
