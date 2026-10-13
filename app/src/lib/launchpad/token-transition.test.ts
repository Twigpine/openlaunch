import { test } from "node:test";
import assert from "node:assert/strict";
import { clearPendingToken, getPendingToken, matchTokenPath, pendingTokenFor, setPendingToken, subscribePendingToken, tokenMorphNames } from "./token-transition.ts";

const PANCHU = { chain: "arc", token: "0x648A5382BDCF286E7FF5122D01A983DB314E620A", name: "Pacharan", symbol: "PANCHU", image: null };

test("morph names are the same for any address casing, distinct per chain, and valid CSS identifiers", () => {
  const a = tokenMorphNames("arc", PANCHU.token);
  const b = tokenMorphNames("arc", PANCHU.token.toLowerCase());
  assert.deepEqual(a, b);
  assert.notEqual(tokenMorphNames("base", PANCHU.token).avatar, a.avatar);
  assert.notEqual(a.avatar, a.name);
  for (const name of [a.avatar, a.name]) assert.match(name, /^[a-z][a-z0-9-]*$/);
});

test("only token routes match, with the address normalised", () => {
  assert.deepEqual(matchTokenPath("/t/arc/0x648A5382BDCF286E7FF5122D01A983DB314E620A"), { chain: "arc", token: PANCHU.token.toLowerCase() });
  assert.deepEqual(matchTokenPath("/t/base/0x648a5382bdcf286e7ff5122d01a983db314e620a/"), { chain: "base", token: PANCHU.token.toLowerCase() });
  assert.equal(matchTokenPath("/t/arc"), null);
  assert.equal(matchTokenPath("/t/arc/0x123"), null);
  assert.equal(matchTokenPath("/launch"), null);
  assert.equal(matchTokenPath(null), null);
});

test("a pending note counts only on the route it was left for", () => {
  setPendingToken(PANCHU);
  try {
    assert.equal(getPendingToken()?.token, PANCHU.token.toLowerCase());
    assert.equal(pendingTokenFor(`/t/arc/${PANCHU.token}`)?.name, "Pacharan");
    assert.equal(pendingTokenFor(`/t/base/${PANCHU.token}`), null, "same address on another chain is another token");
    assert.equal(pendingTokenFor("/"), null);
  } finally {
    clearPendingToken();
  }
  assert.equal(getPendingToken(), null);
});

test("listeners hear a new note and its clearing; unsubscribing stops them", () => {
  let calls = 0;
  const off = subscribePendingToken(() => calls++);
  setPendingToken(PANCHU);
  clearPendingToken();
  clearPendingToken(); // nothing left to clear: no extra notification
  off();
  setPendingToken(PANCHU);
  clearPendingToken();
  assert.equal(calls, 2);
});

test("a note expires on its own so it never leaks into a later visit", async () => {
  setPendingToken(PANCHU, 5);
  assert.notEqual(getPendingToken(), null);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(getPendingToken(), null);
});
