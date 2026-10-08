import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPostFacts } from "./xFetch.ts";

// each source answers as told: ok (with a body), missing (404) or error (500)
type Say = { ok: unknown } | "missing" | "error";
function sources(p: { oembed: Say; syndication: Say; fx: Say }) {
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    const say = u.includes("publish.x.com") ? p.oembed : u.includes("syndication.twimg.com") ? p.syndication : p.fx;
    if (say === "missing") return new Response("", { status: 404 });
    if (say === "error") return new Response("", { status: 500 });
    return Response.json(say.ok);
  }) as typeof fetch;
}
const ID = "1234567890";
const oe = (handle: string, text = "code OL-7K2QXM9A") => ({ ok: { author_url: `https://twitter.com/${handle}`, html: `<blockquote><p>${text}</p>&mdash; x (@${handle})</blockquote>` } });
const syn = (handle: string, userId = "42") => ({ ok: { id_str: ID, text: "code OL-7K2QXM9A", user: { id_str: userId, screen_name: handle } } });
const fx = (handle: string, extra: Record<string, unknown> = {}) => ({ ok: { code: 200, tweet: { id: ID, text: "code OL-7K2QXM9A", author: { id: "999", screen_name: handle, followers: 77, joined: "2020-01-01T00:00:00Z", protected: false, ...extra } } } });

test("X answers: found, author and text from X, account facts from fxtwitter for that same account", async () => {
  sources({ oembed: oe("alice"), syndication: syn("alice"), fx: fx("alice") });
  const f = await fetchPostFacts("alice", ID);
  assert.equal(f.found, true);
  assert.equal(f.handle, "alice");
  assert.equal(f.userId, "42", "the account id comes from X");
  assert.equal(f.followers, 77);
  assert.deepEqual(f.sources, ["oembed", "syndication", "fxtwitter"]);
});

test("only fxtwitter answers: unknown (a person checks it), never verified on a third party's word", async () => {
  sources({ oembed: "error", syndication: "error", fx: fx("alice") });
  const f = await fetchPostFacts("alice", ID);
  assert.equal(f.found, null);
  assert.equal(f.handle, null);
  assert.equal(f.text, null);
});

test("fxtwitter naming another account adds nothing", async () => {
  sources({ oembed: oe("alice"), syndication: "error", fx: fx("mallory") });
  const f = await fetchPostFacts("alice", ID);
  assert.equal(f.found, true);
  assert.equal(f.handle, "alice", "X's author stands");
  assert.equal(f.followers, null);
  assert.equal(f.accountCreated, null);
});

test("the account id never comes from fxtwitter", async () => {
  sources({ oembed: oe("alice"), syndication: "error", fx: fx("alice") });
  const f = await fetchPostFacts("alice", ID);
  assert.equal(f.userId, null, "no X id: the binding stays on the handle until X gives one");
  assert.equal(f.followers, 77);
});

test("one X source says 404 while the other failed: unknown, never 'deleted'", async () => {
  sources({ oembed: "error", syndication: "missing", fx: fx("alice") });
  assert.equal((await fetchPostFacts("alice", ID)).found, null);
  sources({ oembed: "missing", syndication: "error", fx: "error" });
  assert.equal((await fetchPostFacts("alice", ID)).found, null);
});

test("gone only when X is sure: a 404 and no X failure", async () => {
  sources({ oembed: "missing", syndication: "missing", fx: "error" });
  assert.equal((await fetchPostFacts("alice", ID)).found, false);
  sources({ oembed: "missing", syndication: "missing", fx: fx("alice") });
  assert.equal((await fetchPostFacts("alice", ID)).found, false, "fxtwitter cannot bring back a post X says is gone");
});

test("one X source answers while the other says 404: found (the answer wins)", async () => {
  sources({ oembed: "missing", syndication: syn("alice"), fx: "error" });
  const f = await fetchPostFacts("alice", ID);
  assert.equal(f.found, true);
  assert.equal(f.handle, "alice");
});

test("the two X sources disagree on the author: nobody is trusted", async () => {
  sources({ oembed: oe("alice"), syndication: syn("bob"), fx: "error" });
  const f = await fetchPostFacts("alice", ID);
  assert.equal(f.found, true);
  assert.equal(f.handle, null);
});
