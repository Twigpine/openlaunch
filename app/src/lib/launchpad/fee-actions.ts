import type { Abi, Address, PublicClient } from "viem";
import { BUILDER_DATA_SUFFIX } from "../chainPublic";
import { LAUNCH_LOCKER_ABI } from "./abi";
import { QUOTE_VAULT_ABI } from "./quote-abi";
import type { FeeSides } from "./creator";
import { isQuoteFeeLaunch, type LaunchIdentity } from "./suites";
import { SUITE_KINDS } from "./suite-kinds";

/**
 * Collecting and claiming a launch's fees. The locker (lp-v1) and the vault (quote-v2) differ in how pending
 * fees are read and how credits are keyed; the panels call these instead of choosing an ABI themselves.
 */
export type FeeTarget = { launch: Pick<LaunchIdentity, "suite_id" | "fee_asset_mode">; feeContract: Address; tokenId: bigint };

const feeAbi = (t: FeeTarget) => SUITE_KINDS[isQuoteFeeLaunch(t.launch) ? "quote-v2" : "lp-v1"].feeAbi;

/** Uncollected fees, read with eth_call (no gas). The vault exposes them; the locker only reveals them through a simulated collect. */
export async function pendingFees(pub: PublicClient, t: FeeTarget, account: Address): Promise<FeeSides> {
  if (isQuoteFeeLaunch(t.launch)) {
    const quote = await pub.readContract({ address: t.feeContract, abi: QUOTE_VAULT_ABI, functionName: "pendingFees", args: [t.tokenId] });
    return { quote, token: 0n };
  }
  const { result } = await pub.simulateContract({ address: t.feeContract, abi: LAUNCH_LOCKER_ABI, functionName: "collect", args: [t.tokenId], account });
  return { quote: result[0], token: result[1] };
}

/** A simulated `collect(tokenId)`, ready for writeContract. Both fee contracts share the signature. */
export async function collectRequest(pub: PublicClient, t: FeeTarget, account: Address) {
  const { request } = await pub.simulateContract({ address: t.feeContract, abi: feeAbi(t), functionName: "collect", args: [t.tokenId], account, dataSuffix: BUILDER_DATA_SUFFIX });
  return request;
}

/** A simulated claim of the caller's credited balance: per launch on the vault, per currency on the locker. */
export async function claimRequest(pub: PublicClient, t: FeeTarget, account: Address, currency: Address) {
  const { request } = await pub.simulateContract({ address: t.feeContract, abi: feeAbi(t), functionName: "claim", args: isQuoteFeeLaunch(t.launch) ? [t.tokenId] : [currency], account, dataSuffix: BUILDER_DATA_SUFFIX });
  return request;
}

/** One `claimable` read. Both contracts return a uint256; the ABI is left loose so either fits one useReadContracts call. */
export type ClaimableRead = { address: Address; chainId: number; abi: Abi; functionName: "claimable"; args: readonly unknown[] };

/** Reads of `account`'s credited balances for useReadContracts, in [quote, token] order. The vault only ever credits the quote. */
export function claimableContracts(t: FeeTarget, chainId: number, account: Address, quote: Address, token: Address): ClaimableRead[] {
  if (isQuoteFeeLaunch(t.launch)) return [{ address: t.feeContract, chainId, abi: QUOTE_VAULT_ABI, functionName: "claimable" as const, args: [t.tokenId, account] as const }];
  return [quote, token].map((currency) => ({ address: t.feeContract, chainId, abi: LAUNCH_LOCKER_ABI, functionName: "claimable" as const, args: [account, currency] as const }));
}
