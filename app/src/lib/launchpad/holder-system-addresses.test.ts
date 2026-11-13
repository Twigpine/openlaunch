import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { holderRebuildSql, systemAddressesOf } from "./holder-system-addresses";
import { launchpad } from "./config";
import { CHAIN_KEYS } from "@/lib/chainPublic";

test("every chain excludes its own pool, position manager, router, factory and locker", () => {
  for (const chain of CHAIN_KEYS) {
    const cfg = { ...launchpad(chain), factory: `0x${"12".repeat(20)}` as const, locker: `0x${"34".repeat(20)}` as const };
    const excluded = systemAddressesOf(cfg);
    for (const value of [cfg.v4.poolManager, cfg.v4.positionManager, cfg.v4.universalRouter, cfg.v4.permit2, cfg.factory!, cfg.locker!]) {
      assert.ok(excluded.includes(value.toLowerCase()), `${chain}: ${value}`);
    }
  }
});

test("missing factory or locker never produces a partial exclusion set", () => {
  assert.throws(() => systemAddressesOf({ ...launchpad("arc"), factory: null }), /configured arc/);
  assert.throws(() => systemAddressesOf({ ...launchpad("elysium"), locker: null }), /configured elysium/);
});

test("rebuild SQL requires explicit validated configuration and canonicalizes public addresses", () => {
  const a = `0x${"AB".repeat(20)}`;
  assert.match(holderRebuildSql("BEGIN; COMMIT;", { "5042": [a, a] }), new RegExp(`\\{"5042":\\["${a.toLowerCase()}"\\]\\}`));
  for (const values of [{}, { "0": [a] }, { "1;DROP TABLE x": [a] }, { "5042": [] }, { "5042": ["'); DROP SCHEMA public CASCADE; --"] }]) {
    assert.throws(() => holderRebuildSql("BEGIN; COMMIT;", values), /valid configured/);
  }
});

test("holder rebuild locks launches before transfers and refuses unconfigured stored chains", () => {
  const sql = readFileSync(new URL("../../../scripts/rebuild-holders.sql", import.meta.url), "utf8");
  const launches = sql.indexOf("LOCK TABLE bb_launches"), transfers = sql.indexOf("LOCK TABLE bb_token_transfers");
  assert.ok(launches >= 0 && transfers > launches);
  assert.match(sql, /holder rebuild configuration does not cover every stored launch chain/);
  assert.match(sql, /e\.chain_id = h\.chain_id AND e\.address = h\.holder/);
  assert.doesNotMatch(sql, /0x6049|0xe2e105/i, "chain addresses come from configuration, not a second hand-maintained table");
});
