import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { EARN_VAULT_ABI, VAULT_V2_FACTORY_ABI } from "./abi.ts";
import { readSnapshot } from "./server.ts";
import { readTerms, termsCheck } from "./terms.ts";
import { EARN_VAULTS, VAULT_V2_FACTORY_BASE } from "./vaults.ts";
import { fmtRate } from "./math.ts";
import { approvedState } from "./calls.ts";
import { ERC20_MIN_ABI } from "../launchpad/abi.ts";

// Explicit opt-in (RUN_EARN_LIVE_TESTS=1). Reads Base mainnet only: no wallet, no signature, no transaction.
// It is the check to run before relisting or after any news about the vault.
const skip = process.env.RUN_EARN_LIVE_TESTS !== "1";

test("read-only live: the pinned Base vault is still the reviewed Morpho Vault V2", { skip }, async (t) => {
  const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org", { batch: true }) });
  const v = EARN_VAULTS.base!;
  assert.equal(await client.readContract({ address: VAULT_V2_FACTORY_BASE, abi: VAULT_V2_FACTORY_ABI, functionName: "isVaultV2", args: [v.address] }), true);
  assert.deepEqual(termsCheck(v, await readTerms(client, v)), { ok: true });
  assert.ok((await client.readContract({ address: v.address, abi: EARN_VAULT_ABI, functionName: "previewDeposit", args: [1_000_000n] })) > 0n);
  // the batch preflight's allowance override really lands in USDC's allowance mapping
  const owner = "0x00000000000000000000000000000000000e4321";
  assert.equal(await client.readContract({ address: v.asset, abi: ERC20_MIN_ABI, functionName: "allowance", args: [owner, v.address], stateOverride: approvedState(v, owner, 123_456n) }), 123_456n);
  const s = await readSnapshot(v, client);
  t.diagnostic(JSON.stringify({ rate: fmtRate(s.rate), from: s.rateFrom, to: s.rateTo, totalAssets: s.totalAssets }));
  assert.deepEqual(s.terms, { ok: true });
});
