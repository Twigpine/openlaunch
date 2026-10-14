import assert from "node:assert/strict";
import test from "node:test";
import { Attribution } from "ox/erc8021";
import { concatHex, decodeFunctionData, encodeFunctionData, getAddress, maxUint256 } from "viem";
import { BUILDER_CODE, BUILDER_DATA_SUFFIX } from "../chainPublic.ts";
import { ERC20_MIN_ABI } from "../launchpad/abi.ts";
import { EARN_VAULT_ABI } from "./abi.ts";
import { EARN_BATCH_CAPABILITIES, allowanceSlot, approveCall, approvedState, batchHash, canBatch, depositCall, redeemCall, withdrawCall } from "./calls.ts";
import { EARN_VAULTS } from "./vaults.ts";

const vault = EARN_VAULTS.base!;
const owner = getAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");

test("every Earn call is credited to openlaunch's builder code", () => {
  const calls = [approveCall(vault, 1_000_000_000n), depositCall(vault, 1_000_000_000n, owner), withdrawCall(vault, 100_000_000n, owner), redeemCall(vault, 5n, owner)];
  for (const c of calls) {
    assert.ok(c.data.endsWith(BUILDER_DATA_SUFFIX.slice(2)), c.data);
    assert.deepEqual(Attribution.fromData(c.data), { codes: [BUILDER_CODE], id: 0 });
  }
  assert.equal(BUILDER_CODE, "bc_ly9ism19");
});

test("the suffix is the same bytes viem appends for writeContract({ dataSuffix }) on the one-at-a-time path", () => {
  const plain = encodeFunctionData({ abi: EARN_VAULT_ABI, functionName: "deposit", args: [7n, owner] });
  assert.equal(depositCall(vault, 7n, owner).data, concatHex([plain, BUILDER_DATA_SUFFIX]));
});

test("the approval is for exactly the amount, to the vault, on the asset", () => {
  const c = approveCall(vault, 1_234_567n);
  assert.equal(c.to, vault.asset);
  const { functionName, args } = decodeFunctionData({ abi: ERC20_MIN_ABI, data: c.data });
  assert.equal(functionName, "approve");
  assert.deepEqual(args, [vault.address, 1_234_567n]);
  assert.notEqual(args?.[1], maxUint256);
});

test("deposits, withdrawals and redemptions all pay and return to the same wallet", () => {
  const d = decodeFunctionData({ abi: EARN_VAULT_ABI, data: depositCall(vault, 9n, owner).data });
  assert.deepEqual([d.functionName, d.args], ["deposit", [9n, owner]]);
  const w = decodeFunctionData({ abi: EARN_VAULT_ABI, data: withdrawCall(vault, 9n, owner).data });
  assert.deepEqual([w.functionName, w.args], ["withdraw", [9n, owner, owner]]);
  const r = decodeFunctionData({ abi: EARN_VAULT_ABI, data: redeemCall(vault, 9n, owner).data });
  assert.deepEqual([r.functionName, r.args], ["redeem", [9n, owner, owner]]);
  for (const c of [depositCall(vault, 9n, owner), withdrawCall(vault, 9n, owner), redeemCall(vault, 9n, owner)]) assert.equal(c.to, vault.address);
});

test("a batching wallet is asked to tag its own operation too, and may decline", () => {
  assert.deepEqual(EARN_BATCH_CAPABILITIES, { dataSuffix: { value: BUILDER_DATA_SUFFIX, optional: true } });
});

test("the allowance override targets allowed[owner][vault] in USDC's slot-10 mapping", () => {
  // vector from `cast index address <vault> $(cast index address 0x…a1 10)`
  assert.equal(allowanceSlot("0x00000000000000000000000000000000000000A1", vault.address, 10n), "0x225d826c47ad7eee9e6a5f77df704b43c0a9c35932432324101796966f514eec");
  assert.equal(vault.assetAllowanceSlot, 10n);
  // case never matters (and a mixed-case address with an off checksum does not throw)
  assert.equal(allowanceSlot("0x00000000000000000000000000000000000000a1", vault.address.toLowerCase() as `0x${string}`, 10n), allowanceSlot("0x00000000000000000000000000000000000000A1", vault.address, 10n));
  const o = approvedState(vault, "0x00000000000000000000000000000000000000A1", 250_000_000n);
  assert.deepEqual(o, [{ address: vault.asset, stateDiff: [{ slot: "0x225d826c47ad7eee9e6a5f77df704b43c0a9c35932432324101796966f514eec", value: `0x${(250_000_000).toString(16).padStart(64, "0")}` }] }]);
});

test("a batch counts as done only when the wallet reports success for every call", () => {
  assert.equal(batchHash({ status: "success", receipts: [{ status: "success", transactionHash: "0x01" }, { status: "success", transactionHash: "0x02" }] }), "0x02");
  assert.equal(batchHash({ status: "success", receipts: [] }), null);
  assert.throws(() => batchHash({ status: "failure", receipts: [] }), /failed/);
  assert.throws(() => batchHash({ status: "success", receipts: [{ status: "reverted", transactionHash: "0x01" }] }), /failed/);
});

test("only wallets that already batch take the batch path; an EIP-7702 upgrade prompt is never triggered", () => {
  assert.equal(canBatch({ atomic: { status: "supported" } }), true);
  assert.equal(canBatch({ atomicBatch: { supported: true } }), true);
  assert.equal(canBatch({ atomic: { status: "ready" } }), false);
  assert.equal(canBatch({ atomic: { status: "unsupported" } }), false);
  assert.equal(canBatch({}), false);
  assert.equal(canBatch(null), false);
  assert.equal(canBatch(undefined), false);
});
