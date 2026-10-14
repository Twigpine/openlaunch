import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { en } from "../../i18n/messages/index.ts";
import { REPORT_REASONS } from "../../lib/launchpad/posts.ts";

/**
 * Source contracts for the posts UI in two languages. The posts lib and the posts API give their failure reasons in
 * English; Posts.tsx shows each known one as a message (posts.errors.*), so these keep the two in step: every translated
 * reason is one the code really gives, and its English message reads exactly as the reason did. (friendlyError words
 * its own reasons in the reader's language.)
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const posts = read("./Posts.tsx");
// the reasons as the code writes them: the lib's and the API's own strings, and the fallbacks Posts.tsx throws with
const given = [
  ...["../../lib/launchpad/posts.ts", "../../lib/launchpad/postsServer.ts", "../../app/api/posts/route.ts", "../../app/api/posts/report/route.ts", "../../app/api/posts/mod/route.ts"].map(read),
  ...[...posts.matchAll(/d\.error \?\? ("[^"]+")/g)].map((m) => m[1]),
].join("\n");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("every failure reason the posts UI translates is one the code really gives", () => {
  for (const [key, english] of Object.entries(en.posts.errors)) {
    // a placeholder stands for a template expression: "wait {seconds}s between posts" is `wait ${…}s between posts`
    const pattern = english.split(/\{\w+\}/).map(escape).join("\\$\\{[^}]+\\}");
    assert.match(given, new RegExp(`["\`]${pattern}["\`]`), `posts.errors.${key} ("${english}") is not a reason the code gives`);
  }
});

test("each reason maps to its own message, and the English message reads exactly as the reason did", () => {
  const mapped = new Map([...posts.matchAll(/^\s*\["([^"]+)", "(\w+)"\],$/gm)].map((m) => [m[2], m[1]]));
  for (const [key, english] of Object.entries(en.posts.errors)) {
    if (key === "wait" || key === "tooLong") continue; // the two templates, read back by pattern below
    assert.equal(mapped.get(key), english, `REASONS maps "${english}" to errors.${key}`);
  }
  assert.match(posts, /\/\^wait \(\\d\+\)s between posts\$\/\.exec\(reason\)/);
  assert.match(posts, /t\("errors\.wait", \{ seconds: Number\(wait\[1\]\) \}\)/);
  assert.match(posts, /\/\^max \(\\d\+\) characters\$\/\.exec\(reason\)/);
  assert.match(posts, /t\("errors\.tooLong", \{ max: Number\(max\[1\]\) \}\)/);
});

test("a wallet signs the code's own words: a report reason is signed as its code and only shown translated", () => {
  assert.match(posts, /buildReportMessage\(\{ postId: p\.id, wallet: address, nonce: n, ts, reason \}\)/);
  assert.match(posts, /onReport\(r\);/);
  assert.match(posts, /\{t\(`item\.reasons\.\$\{r\}`\)\}/);
  assert.deepEqual(Object.keys(en.posts.item.reasons), [...REPORT_REASONS]);
});
