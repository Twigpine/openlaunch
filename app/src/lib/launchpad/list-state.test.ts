import { test } from "node:test";
import assert from "node:assert/strict";
import { launchKey, matchesListSelection, mergeLaunches, refreshInPlace } from "./list-state.ts";
import { MCAP_POLICY_VERSION } from "./mcap-policy.ts";

test("market-cap requests reject previous modes, old servers and previous pages", () => {
  const wanted = { sort: "mcap", window: "all", chain: null, filter: null, mcap: "filtered" as const, limit: 40 };
  const response = { ...wanted, mcap_policy: MCAP_POLICY_VERSION };
  assert.equal(matchesListSelection(wanted, response), true);
  assert.equal(matchesListSelection(wanted, { ...response, mcap: "all" }), false);
  assert.equal(matchesListSelection(wanted, { ...response, mcap_policy: undefined }), false);
  assert.equal(matchesListSelection(wanted, { ...response, mcap: undefined }), false);
  assert.equal(matchesListSelection(wanted, { ...response, limit: 80 }), false);
  assert.equal(matchesListSelection(wanted, { ...response, chain: "arc" }), false);
  assert.equal(matchesListSelection({ ...wanted, sort: "new" }, { ...response, sort: "new", mcap_policy: undefined, mcap: undefined }), true);
});

test("launch identity includes chain and normalizes address case", () => {
  assert.equal(launchKey({ chain: "base", token: "0xAbC" }), "base:0xabc");
  assert.notEqual(launchKey({ chain: "base", token: "0xabc" }), launchKey({ chain: "robinhood", token: "0xabc" }));
});

test("pagination deduplicates only within a chain and refreshes existing values", () => {
  const a = { chain: "base", token: "0xabc", count: 1 };
  const b = { chain: "robinhood", token: "0xabc", count: 2 };
  assert.deepEqual(mergeLaunches([a], [{ ...a, count: 3 }, b, b]), [{ ...a, count: 3 }, b]);
});

test("interaction holds order and targets while refreshing market data", () => {
  const a = { chain: "base", token: "0xabc", count: 1 };
  const b = { chain: "robinhood", token: "0xabc", count: 2 };
  const c = { chain: "base", token: "0xdef", count: 5 };
  assert.deepEqual(refreshInPlace([a, b], [c, { ...b, count: 4 }, { ...a, count: 3 }]), [{ ...a, count: 3 }, { ...b, count: 4 }]);
  assert.deepEqual(refreshInPlace([a, b], []), [a, b]);
});
