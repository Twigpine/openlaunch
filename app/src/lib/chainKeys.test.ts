import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { CHAIN_IDS, CHAIN_KEYS, CHAIN_KEY_PATTERN, CHAIN_LABELS, CHAIN_SHORT, DEFAULT_CHAIN, EXPLORERS, chainKeyOf, chainKeyOr, chainList, isChainKey } from "./chainKeys.ts";
import { CHAINS, chainIdOf, explorerAddress, explorerName, explorerTx } from "./chainPublic.ts";

test("every chain key has an id, labels, an explorer and a viem chain with the same id", () => {
  assert.ok(CHAIN_KEYS.includes(DEFAULT_CHAIN));
  assert.equal(new Set(CHAIN_KEYS.map((k) => CHAIN_IDS[k])).size, CHAIN_KEYS.length, "chain ids are unique");
  for (const k of CHAIN_KEYS) {
    assert.equal(CHAINS[k].id, CHAIN_IDS[k], `${k}: chainKeys id matches the viem chain`);
    assert.equal(chainIdOf(k), CHAIN_IDS[k]);
    assert.ok(CHAIN_LABELS[k] && CHAIN_SHORT[k], `${k}: labels`);
    // an origin, or an origin and a path (Elysium's explorer lives under /explorer): never a trailing slash, so `${url}/tx/…` joins cleanly
    assert.match(EXPLORERS[k].url, /^https:\/\/[^/]+(\/[^/]+)*$/, `${k}: explorer base URL, no trailing slash`);
    assert.equal(explorerName(k), EXPLORERS[k].name);
  }
  assert.equal(explorerTx("base", "0xabc"), "https://basescan.org/tx/0xabc");
  assert.equal(explorerAddress("robinhood", "0xdef"), "https://robinhoodchain.blockscout.com/address/0xdef");
  assert.equal(explorerName("base"), "Basescan");
  assert.equal(explorerName("robinhood"), "Blockscout");
  assert.equal(explorerAddress("elysium", "0xdef"), "https://elysium.kinetiq.xyz/explorer/address/0xdef");
  assert.equal(explorerTx("elysium", "0xabc"), "https://elysium.kinetiq.xyz/explorer/tx/0xabc");
});

test("chain keys parse strictly and round-trip through chain ids", () => {
  for (const k of CHAIN_KEYS) {
    assert.equal(isChainKey(k), true);
    assert.equal(chainKeyOf(CHAIN_IDS[k]), k);
  }
  for (const bad of ["", "Base", "BASE", "eth", "toString", "__proto__", null, undefined, 8453, {}]) assert.equal(isChainKey(bad), false, String(bad));
  assert.equal(chainKeyOf(1), null);
  assert.equal(chainKeyOf(null), null);
  assert.equal(chainKeyOf(undefined), null);
  assert.equal(chainKeyOr("robinhood", DEFAULT_CHAIN), "robinhood");
  assert.equal(chainKeyOr("nope", DEFAULT_CHAIN), "base");
  assert.equal(chainKeyOr(undefined, null), null);
});

test("chainList and CHAIN_KEY_PATTERN name every chain", () => {
  assert.equal(chainList(), "Base, Robinhood Chain, Arc or Elysium");
  assert.equal(chainList("&", CHAIN_SHORT), "Base, Robinhood, Arc & Elysium");
  assert.equal(CHAIN_KEY_PATTERN, "base|robinhood|arc|elysium");
  const re = new RegExp(`^token:(${CHAIN_KEY_PATTERN}):(0x[0-9a-f]{40})$`);
  assert.ok(re.test(`token:robinhood:0x${"a".repeat(40)}`));
  assert.ok(re.test(`token:arc:0x${"a".repeat(40)}`));
  assert.ok(re.test(`token:elysium:0x${"a".repeat(40)}`));
  assert.ok(!re.test(`token:basex:0x${"a".repeat(40)}`));
});

/**
 * Guard: a two-way branch on a chain name (`chain === "base" ? … : …`) sends every other chain down the
 * second arm, so a newly added chain would silently get Robinhood's RPC, registry or copy. Per-chain
 * behaviour goes in a `Record<ChainKey, …>` instead. The allowlist holds the Base-only B20 precompile
 * fallback, where "every other chain" correctly means "no fallback".
 */
test("no source branches on a chain name or hardcodes a chain id outside the registry", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(p) && !/\.test\.ts$/.test(p)) files.push(p);
    }
  };
  walk(root);
  const allowed = new Set(["lib/chain.ts:B20", "app/api/rpc/route.ts:B20"]);
  const offenders: string[] = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/^\s*\*.*$/, "").replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, ""); // comments (and anything after // such as a URL) do not count
      // the bridge speaks Relay's own chain ids and names (numeric ids, solverChainId "base") by design: not our registry
      if (/^(lib\/bridge|components\/bridge|app\/ui-review-bridge)\//.test(rel)) return;
      const branch = /[!=]==\s*"(base|robinhood|arc|elysium)"|"(base|robinhood|arc|elysium)"\s*[!=]==|\?\?\s*"(base|robinhood|arc|elysium)"/.test(code);
      const id = /\b(8453|4663|5042|99901)\b/.test(code) && !/^(lib\/chainKeys\.ts|lib\/chainPublic\.ts|lib\/chain-mock\.ts|lib\/launchpad\/stocks\.ts|app\/rules\/page\.tsx|app\/llms\.txt\/route\.ts)$/.test(rel);
      if (!branch && !id) return;
      if (branch && /b20/i.test(code) && allowed.has(`${rel}:B20`)) return;
      offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(offenders, [], "use a Record<ChainKey, …> lookup instead");
});
