import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { communityFingerprint, filterCommunityPosts, reconcileCommunityWindow, revealCommunityPosts } from "./community-feed.ts";

const posts = [
  { id: 1, chain: "base", token: "0xAbC", wallet: "0xWallet", symbol: "SKY", name: "Clear Sky", body: "A real conversation", tag: "creator", created_at: "2026-09-07T00:00:00Z" },
  { id: 2, chain: "robinhood", token: "0xAbC", wallet: "0xAnother", symbol: "MOON", name: "Moon", body: "Something different", tag: null, created_at: "2026-09-07T00:00:01Z" },
];
test("community filters stay chain-scoped and search loaded content without mutating posts", () => {
  assert.deepEqual(filterCommunityPosts(posts, "base", "  sky "), [posts[0]]);
  assert.deepEqual(filterCommunityPosts(posts, null, "0xabc"), posts);
  assert.deepEqual(filterCommunityPosts(posts, "robinhood", "conversation"), []);
  assert.deepEqual(filterCommunityPosts(posts, null, "wallet"), [posts[0]]);
  assert.deepEqual(filterCommunityPosts(posts, null, " "), posts);
  assert.equal(posts.length, 2);
});
test("Arc posts remain searchable and reveal independently from the other chains", () => {
  const arc = { ...posts[0], id: 3, chain: "arc", symbol: "ARC", body: "Arc launch discussion" };
  const base = { ...posts[0], id: 4 };
  const source = [base, arc, ...posts];
  assert.deepEqual(filterCommunityPosts(source, "arc", "discussion"), [arc]);
  assert.deepEqual(filterCommunityPosts(source, "arc", "moon"), []);
  const queued = reconcileCommunityWindow({ visible: posts, pending: [] }, source, true);
  const selected = filterCommunityPosts(queued.pending, "arc", "");
  const revealed = revealCommunityPosts(queued, source, selected.map((post) => post.id));
  assert.deepEqual(revealed.visible, [arc, ...posts]);
  assert.deepEqual(revealed.pending, [base], "revealing Arc does not discard Base notifications");
  assert.deepEqual(reconcileCommunityWindow(revealed, source, true), revealed);
});
test("community refresh compares the shared 30-post window while retaining full server results", () => {
  const rows = Array.from({ length: 100 }, (_, id) => ({ ...posts[0], id }));
  assert.equal(communityFingerprint(rows), communityFingerprint(rows.slice(0, 30)));
  assert.notEqual(communityFingerprint(posts), communityFingerprint(posts.slice(1)));
  assert.notEqual(communityFingerprint(posts), communityFingerprint([{ ...posts[0], body: "Changed" }, posts[1]]));
  assert.notEqual(communityFingerprint(posts), communityFingerprint([{ ...posts[0], name: "Renamed token" }, posts[1]]));
});
test("feed additions wait while reading, while authoritative edits and removals apply immediately", () => {
  const added = { ...posts[0], id: 3, body: "A new post" };
  const edited = { ...posts[0], body: "Edited by the server" };
  const result = reconcileCommunityWindow({ visible: posts, pending: [] }, [added, edited], true);
  assert.deepEqual(result.visible, [edited]);
  assert.deepEqual(result.pending, [added]);
  assert.equal(posts[0].body, "A real conversation", "previous rows are not mutated");
});
test("the queue reflects the latest server window, not stale additions", () => {
  const first = { ...posts[0], id: 3, body: "Pending" };
  const next = { ...posts[0], id: 4, body: "More recent" };
  const queued = reconcileCommunityWindow({ visible: posts, pending: [] }, [first, ...posts], true);
  const updated = reconcileCommunityWindow(queued, [next, { ...first, body: "Pending, edited" }, ...posts], true);
  assert.deepEqual(updated.pending.map((post) => post.body), ["More recent", "Pending, edited"]);
  const moderated = reconcileCommunityWindow(updated, [next, ...posts], true);
  assert.deepEqual(moderated.pending, [next], "moderated queued posts disappear without being revealed");
  const revealed = reconcileCommunityWindow(moderated, [next, ...posts], false);
  assert.deepEqual(revealed, { visible: [next, ...posts], pending: [] });
});
test("buffered and visible rows together preserve the authoritative 100-row window", () => {
  const initial = Array.from({ length: 100 }, (_, index) => ({ ...posts[0], id: 100 - index }));
  const latest = [{ ...posts[0], id: 101 }, ...initial.slice(0, 99)];
  const buffered = reconcileCommunityWindow({ visible: initial, pending: [] }, latest, true);
  assert.equal(buffered.visible.length, 99);
  assert.equal(buffered.pending.length, 1);
  assert.equal(buffered.visible.at(-1)?.id, 2, "rows outside the server window are not kept indefinitely");
  assert.ok(buffered.visible.some((post) => post.id === 25), "older rows outside the 30-row live signal stay loaded");
  const repeated = reconcileCommunityWindow(buffered, latest, true);
  assert.deepEqual(repeated, buffered, "identical polls do not accumulate duplicates");
  assert.equal(reconcileCommunityWindow(repeated, [...latest, initial[99]], false).visible.length, 100);
});
test("hidden rows and duplicated IDs never enter either feed window", () => {
  const hidden = { ...posts[0], id: 3, hidden: true };
  const result = reconcileCommunityWindow({ visible: posts, pending: [] }, [hidden, posts[0], posts[0]], true);
  assert.deepEqual(result, { visible: [posts[0]], pending: [] });
  assert.deepEqual(reconcileCommunityWindow(result, [], true), { visible: [], pending: [] });
});
test("visible and queued counts use the same chain and search filters", () => {
  const next = { ...posts[1], id: 3 };
  const buffered = reconcileCommunityWindow({ visible: posts, pending: [] }, [next, ...posts], true);
  assert.equal(filterCommunityPosts(buffered.pending, "base", "").length, 0);
  assert.equal(filterCommunityPosts(buffered.pending, "robinhood", " moon ").length, 1);
  assert.equal(filterCommunityPosts(buffered.visible, "robinhood", " moon ").length, 1);
});

test("revealing one chain leaves other-chain notifications queued in server order", () => {
  const source = [
    { ...posts[1], id: 6 }, { ...posts[0], id: 5 },
    { ...posts[1], id: 4 }, { ...posts[0], id: 3 }, ...posts,
  ];
  const queued = reconcileCommunityWindow({ visible: posts, pending: [] }, source, true);
  const selected = filterCommunityPosts(queued.pending, "base", "");
  const revealed = revealCommunityPosts(queued, source, selected.map((post) => post.id));
  assert.deepEqual(revealed.visible.map((post) => post.id), [5, 3, 1, 2]);
  assert.deepEqual(revealed.pending.map((post) => post.id), [6, 4]);
  assert.equal(filterCommunityPosts(revealed.pending, "robinhood", "").length, 2);
  assert.deepEqual(reconcileCommunityWindow(revealed, source, true), revealed, "a refresh keeps unrevealed notifications");
  assert.deepEqual(queued.pending.map((post) => post.id), [6, 5, 4, 3], "the previous window is not mutated");
  const all = revealCommunityPosts(revealed, source, revealed.pending.map((post) => post.id));
  assert.deepEqual(all, { visible: source, pending: [] }, "clearing filters can reveal the remaining batch");
});

test("search reveals preserve nonmatching posts on the same chain and other chains", () => {
  const source = [
    { ...posts[1], id: 5, body: "Needle" },
    { ...posts[0], id: 4, body: "Unrelated" },
    { ...posts[0], id: 3, body: "Needle" }, ...posts,
  ];
  const queued = reconcileCommunityWindow({ visible: posts, pending: [] }, source, true);
  for (const chain of [null, "base"]) {
    const selected = filterCommunityPosts(queued.pending, chain, "  needle ");
    const revealed = revealCommunityPosts(queued, source, selected.map((post) => post.id));
    assert.equal(filterCommunityPosts(revealed.pending, chain, "needle").length, 0);
    assert.deepEqual(revealed.pending.map((post) => post.id), chain ? [5, 4] : [4]);
    assert.deepEqual(filterCommunityPosts(revealed.visible, chain, "needle"), selected);
  }
  assert.deepEqual(revealCommunityPosts(queued, source, []), queued, "an empty selection consumes nothing");
});

test("an empty filtered view reveals its matching posts without draining other views", () => {
  const source = [{ ...posts[1], id: 4 }, { ...posts[0], id: 3 }];
  const queued = reconcileCommunityWindow({ visible: [], pending: [] }, source, true);
  const selected = filterCommunityPosts(queued.pending, "base", "");
  const revealed = revealCommunityPosts(queued, source, selected.map((post) => post.id));
  assert.deepEqual(revealed, { visible: [source[1]], pending: [source[0]] });
});

test("stale reveal IDs cannot restore moderated rows or consume later additions", () => {
  const first = { ...posts[0], id: 3 };
  const other = { ...posts[1], id: 4 };
  const queued = reconcileCommunityWindow({ visible: posts, pending: [] }, [other, first, ...posts], true);
  const latest = [{ ...posts[0], id: 5 }, { ...other, body: "Edited while queued" }, { ...first, hidden: true }, posts[1]];
  const revealed = revealCommunityPosts(queued, latest, [3, 5, 999]);
  assert.deepEqual(revealed.visible, [posts[1]], "server removals and moderation still apply");
  assert.deepEqual(revealed.pending, latest.slice(0, 2), "unseen IDs cannot authorize a later addition");
});

test("partial reveals retain the bounded, deduplicated authoritative window", () => {
  const initial = Array.from({ length: 100 }, (_, index) => ({ ...posts[0], id: 100 - index }));
  const source = [{ ...posts[0], id: 102 }, { ...posts[0], id: 101 }, ...initial];
  const queued = reconcileCommunityWindow({ visible: initial, pending: [] }, source, true);
  const revealed = revealCommunityPosts(queued, source, [101, 101]);
  assert.equal(revealed.visible.length, 99);
  assert.deepEqual(revealed.pending.map((post) => post.id), [102]);
  assert.equal(revealed.visible[0].id, 101);
  assert.equal(revealed.visible.at(-1)?.id, 3);
});

test("the actual Show handler keeps filtered notifications and intervening refreshes", () => {
  const source = readFileSync(new URL("../../components/sections/CommunityFeed.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("CommunityFeed.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration = "";
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "showNewPosts") declaration = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(declaration, "the component must provide its Show handler");
  const authoritative = [{ ...posts[1], id: 4 }, { ...posts[0], id: 3 }, ...posts];
  const feed = { source: authoritative, ...reconcileCommunityWindow({ visible: posts, pending: [] }, authoritative, true) };
  type FeedState = typeof feed;
  let update: FeedState | ((current: FeedState) => FeedState) | undefined;
  let entering: number[] = [];
  let clearEntry: (() => void) | undefined;
  const { outputText } = ts.transpileModule(`(${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  // Execute the real handler with inert React setters/timer, not a copy of it.
  const show = runInNewContext(outputText, {
    feed, pending: filterCommunityPosts(feed.pending, "base", ""),
    reconcileCommunityWindow, revealCommunityPosts, entryTimer: { current: null },
    setFeed: (next: typeof update) => { update = next; },
    setEntering: (ids: number[]) => { entering = Array.from(ids); },
    setTimeout: (callback: () => void, delay: number) => { assert.equal(delay, 250); clearEntry = callback; return 1; },
    clearTimeout: () => {},
  }) as () => void;
  show();
  assert.ok(update);
  const latest = [{ ...posts[1], id: 5 }, { ...authoritative[0], body: "Edited" }, ...authoritative.slice(1)];
  const current = { source: latest, ...reconcileCommunityWindow(feed, latest, true) };
  const revealed = typeof update === "function" ? update(current) : update;
  assert.equal(revealed.source, latest, "the handler must not overwrite a newer server payload");
  assert.deepEqual(revealed.pending.map((post) => post.id), [5, 4]);
  assert.equal(revealed.pending[1].body, "Edited");
  assert.deepEqual(revealed.visible.map((post) => post.id), [3, 1, 2]);
  assert.deepEqual(entering, [3], "only posts represented by the clicked button animate");
  assert.ok(clearEntry);
  clearEntry();
  assert.deepEqual(entering, []);
});

test("reader-at-top updates publish the current server rows without a queue", () => {
  const next = { ...posts[1], id: 3 };
  const result = reconcileCommunityWindow({ visible: posts, pending: [] }, [next, ...posts], false);
  assert.deepEqual(result, { visible: [next, ...posts], pending: [] });
});
test("community remains read-only with token-thread links and shared refresh signals", () => {
  const source = readFileSync(new URL("../../components/sections/CommunityFeed.tsx", import.meta.url), "utf8");
  assert.match(source, /subscribe\(\(snap\)/);
  assert.match(source, /router\.refresh\(\)/);
  assert.match(source, /nowMs\(\) - fullWindowRefresh\.current < 60_000/);
  assert.match(source, /#comments/);
  assert.match(source, /Search covers only the recent posts loaded here/);
  assert.match(source, /aria-label="Search recent posts"/);
  assert.doesNotMatch(source, /signMessage|writeContract|dangerouslySetInnerHTML|setInterval/);
});
test("new-post UI anchors server updates, preserves filters, and animates only explicit reveals", () => {
  const source = readFileSync(new URL("../../components/sections/CommunityFeed.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../components/sections/CommunityFeed.module.css", import.meta.url), "utf8");
  assert.match(source, /if \(!loadError && initial !== feed\.source\)/, "load errors are not authoritative removals");
  assert.match(source, /readingDown \|\| feed\.pending\.length > 0/, "a queued batch waits for consent even if the reader scrolls up");
  assert.match(source, /getSnapshotBeforeUpdate/);
  assert.match(source, /!this\.props\.preservePosition/, "the page does not scroll on an automatic update while still at the top");
  assert.match(source, /previous\.filterKey !== this\.props\.filterKey/, "manual filters do not trigger scroll restoration");
  assert.match(source, /row\.getBoundingClientRect\(\)\.top - anchor\.top/);
  assert.match(source, /behavior: "instant"/, "scroll correction must not animate");
  assert.match(source, /setTimeout\(\(\) => setEntering\(\[\]\), 250\)/, "entry state expires even with reduced motion");
  assert.match(css, /\.newPostsSlot[^}]*height: 0/, "the notification reserves no extra document height");
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.postEntering \{ animation: none;/);
  const subscription = source.slice(source.indexOf("subscribe((snap)"), source.indexOf("const shown ="));
  assert.doesNotMatch(subscription, /reconcileCommunityWindow|setEntering/, "the short poll is only a refresh signal and cannot replay entry motion");
});
