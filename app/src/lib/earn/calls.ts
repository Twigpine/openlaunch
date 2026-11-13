import { concatHex, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, type Address, type Hex, type StateOverride } from "viem";
import { ERC20_MIN_ABI } from "../launchpad/abi.ts";
import { BUILDER_DATA_SUFFIX } from "../chainPublic.ts";
import { EARN_VAULT_ABI } from "./abi.ts";
import type { EarnVault } from "./vaults.ts";

/**
 * The exact calls an Earn action sends (pure). Every one ends with openlaunch's ERC-8021 builder-code suffix, so Base
 * credits the deposit, withdrawal and approval to bc_ly9ism19 (lib/chainPublic.ts). The suffix sits after the ABI
 * arguments, where the token and the vault ignore it (the fork run in docs/earn.md proves both accept it).
 *
 * Wallets that send one transaction at a time get these through simulateContract + writeContract with
 * `dataSuffix: BUILDER_DATA_SUFFIX` (the same bytes); smart wallets that batch get them through `sendCalls`, which also
 * carries the code as the `dataSuffix` capability so the wallet tags its own operation too.
 */
export type EarnCall = { to: Address; data: Hex };

/** Calldata with the builder-code suffix appended after the ABI arguments. */
const tagged = (data: Hex): Hex => concatHex([data, BUILDER_DATA_SUFFIX]);

/** Allow the vault to take exactly `amount` of the asset. Never more: an unspent exact allowance is the worst case. */
export function approveCall(vault: EarnVault, amount: bigint): EarnCall {
  return { to: vault.asset, data: tagged(encodeFunctionData({ abi: ERC20_MIN_ABI, functionName: "approve", args: [vault.address, amount] })) };
}

/** Deposit `amount` of the asset; the shares go to `owner`, the wallet that pays. */
export function depositCall(vault: EarnVault, amount: bigint, owner: Address): EarnCall {
  return { to: vault.address, data: tagged(encodeFunctionData({ abi: EARN_VAULT_ABI, functionName: "deposit", args: [amount, owner] })) };
}

/** Take exactly `assets` out, back to the same wallet. */
export function withdrawCall(vault: EarnVault, assets: bigint, owner: Address): EarnCall {
  return { to: vault.address, data: tagged(encodeFunctionData({ abi: EARN_VAULT_ABI, functionName: "withdraw", args: [assets, owner, owner] })) };
}

/** Burn `shares` (every share, for "withdraw all") for the asset, back to the same wallet. */
export function redeemCall(vault: EarnVault, shares: bigint, owner: Address): EarnCall {
  return { to: vault.address, data: tagged(encodeFunctionData({ abi: EARN_VAULT_ABI, functionName: "redeem", args: [shares, owner, owner] })) };
}

/** The storage slot of `allowed[owner][spender]` in a Solidity mapping-of-mappings at `mappingSlot`. */
export function allowanceSlot(owner: Address, spender: Address, mappingSlot: bigint): Hex {
  // lowercased: the encoding ignores case, and viem rejects a mixed-case address whose checksum is off
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner.toLowerCase() as Address, mappingSlot]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender.toLowerCase() as Address, inner]));
}

/**
 * The approval's only effect, as a state override: the vault allowed exactly `amount` of the owner's asset. With it a
 * simulation runs the deposit as the batch will, right after its approval, so the whole [approve, deposit] batch is
 * simulated before the wallet's one prompt.
 */
export function approvedState(vault: EarnVault, owner: Address, amount: bigint): StateOverride {
  return [{ address: vault.asset, stateDiff: [{ slot: allowanceSlot(owner, vault.address, vault.assetAllowanceSlot), value: numberToHex(amount, { size: 32 }) }] }];
}

/**
 * A batch's final status as the transaction hash to show (the last receipt's; null when the wallet reports none).
 * Anything but success with every receipt successful throws: that is a final failure, after which sending again is safe.
 */
export function batchHash(result: { status?: string; receipts?: readonly { status?: string; transactionHash?: Hex }[] }): Hex | null {
  const receipts = result.receipts ?? [];
  if (result.status !== "success" || receipts.some((r) => r.status !== "success")) throw new Error(BATCH_FAILED);
  return receipts.at(-1)?.transactionHash ?? null;
}

/**
 * A batch the wallet reports as failed. Not "reverted on-chain": a batch can fail before it reaches the chain, so
 * whether gas was charged is not known. Atomic, so nothing in it took effect.
 */
export const BATCH_FAILED = "Your wallet reports the transaction failed. Nothing moved; check its activity before trying again.";

/** The EIP-5792 capability that asks a batching wallet to tag its own operation with the builder code. */
export const EARN_BATCH_CAPABILITIES = { dataSuffix: { value: BUILDER_DATA_SUFFIX, optional: true } } as const;

/**
 * Whether to send through `sendCalls`: only for a wallet that already executes atomic batches ("supported"), such as
 * Coinbase Smart Wallet. "ready" means the wallet would first upgrade an ordinary account into a smart one (EIP-7702),
 * a prompt nobody should meet in the middle of a deposit, so those wallets take the one-at-a-time path. Older wallets
 * report the pre-2.0 `atomicBatch.supported` flag.
 */
export function canBatch(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const c = capabilities as { atomic?: { status?: unknown }; atomicBatch?: { supported?: unknown } };
  return c.atomic?.status === "supported" || c.atomicBatch?.supported === true;
}
