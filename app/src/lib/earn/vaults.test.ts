import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "viem";
import { BASE_USDC } from "../bridge/types.ts";
import { CHAIN_KEYS } from "../chainKeys.ts";
import { EARN_VAULTS, VAULT_V2_FACTORY_BASE, earnChains } from "./vaults.ts";

test("Base has the one reviewed vault; every other chain says none explicitly", () => {
  assert.deepEqual(earnChains(), ["base"]);
  for (const chain of CHAIN_KEYS) assert.ok(chain in EARN_VAULTS, chain);
  assert.equal(EARN_VAULTS.robinhood, null);
  assert.equal(EARN_VAULTS.arc, null);
});

test("the Base vault is Steakhouse Prime USDC on Circle's USDC, listed with no fees", () => {
  const v = EARN_VAULTS.base!;
  assert.equal(v.address, getAddress("0xbeef0e0834849acc03f0089f01f4f1eeb06873c9"));
  assert.equal(v.address, "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9");
  assert.equal(v.asset, BASE_USDC);
  assert.equal(v.assetDecimals, 6);
  assert.equal(v.shareDecimals, 18);
  assert.equal(v.name, "Steakhouse Prime USDC");
  assert.deepEqual([v.reviewed.performanceFee, v.reviewed.managementFee], [0n, 0n]);
  assert.equal(VAULT_V2_FACTORY_BASE, getAddress(VAULT_V2_FACTORY_BASE));
});
