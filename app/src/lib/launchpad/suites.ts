import { type Address } from "viem";
import { launchpad, NATIVE } from "./config";
import { type ChainKey } from "../chainPublic";
import { type PoolKey } from "./swap";
import { isQuoteHook, nonZeroAddress, parseBlock, quoteDeployment } from "./quote-config";

export type FeeAssetMode = "both" | "quote";
export type SuiteId = "lp-v1" | "quote-v2";
export type LaunchSuite = {
  id: SuiteId;
  chain: ChainKey;
  factory: Address;
  locker: Address;
  feeContract: Address;
  hook: Address;
  feeAssetMode: FeeAssetMode;
  deployBlock: bigint;
  launchEnabled: boolean;
};
const LEGACY_BLOCK: Record<ChainKey, () => string | undefined> = {
  base: () => process.env.LAUNCH_DEPLOY_BLOCK,
  robinhood: () => process.env.LAUNCH_DEPLOY_BLOCK_ROBINHOOD,
  arc: () => process.env.LAUNCH_DEPLOY_BLOCK_ARC,
};

/** The launch suites configured on a chain: the original locker-based one, and the quote-only one where deployed. */
export function launchSuites(chain: ChainKey): LaunchSuite[] {
  const cfg = launchpad(chain);
  const suites: LaunchSuite[] = cfg.factory && cfg.locker ? [{ id: "lp-v1", chain, factory: cfg.factory, locker: cfg.locker,
    feeContract: cfg.locker, hook: NATIVE, feeAssetMode: "both", deployBlock: parseBlock(LEGACY_BLOCK[chain]()), launchEnabled: true }] : [];
  const quote = quoteDeployment(chain);
  if (quote) suites.push({ ...quote, id: "quote-v2", chain, feeAssetMode: "quote" });
  return suites;
}

/** One configured suite by id, or null. */
export function suiteFor(chain: ChainKey, id: SuiteId = "lp-v1"): LaunchSuite | null {
  return launchSuites(chain).find((s) => s.id === id) ?? null;
}
/** Whether a stored suite id is one this build knows. */
export function isSuiteId(value: unknown): value is SuiteId { return value === "lp-v1" || value === "quote-v2"; }
export type LaunchIdentity = {
  chain: ChainKey; suite_id?: string; fee_asset_mode?: FeeAssetMode; factory_address?: string | null;
  locker_address?: string | null; fee_contract_address?: string | null; hook_address?: string | null;
};
/** A launch's recorded contract. Only migrated v1 records may omit it; they fall back to the original deployment. */
function recordedContract(l: LaunchIdentity, recorded: string | null | undefined, legacy: "feeContract" | "locker"): Address | null {
  if (l.suite_id !== undefined && !isSuiteId(l.suite_id)) return null;
  if (recorded != null) return nonZeroAddress(recorded);
  return isQuoteFeeLaunch(l) ? null : suiteFor(l.chain, "lp-v1")?.[legacy] ?? null;
}
/** The contract that collects and pays this launch's fees (locker or vault), or null when its identity is incomplete. */
export function feeContractForLaunch(l: LaunchIdentity): Address | null {
  return recordedContract(l, l.fee_contract_address, "feeContract");
}
/** The locker that holds this launch's position NFT (each suite deploys its own). */
export function lockerForLaunch(l: LaunchIdentity): Address | null {
  return recordedContract(l, l.locker_address, "locker");
}
/** Whether a launch's fees are charged only in the quote asset (the quote-v2 suite). */
export function isQuoteFeeLaunch(l: Pick<LaunchIdentity, "suite_id" | "fee_asset_mode">): boolean {
  return l.suite_id === "quote-v2" || l.fee_asset_mode === "quote";
}
/** The launch's Uniswap v4 pool key from its stored identity; throws for a quote-only launch whose hook or pool fee is missing. */
export function poolKeyForLaunch(l: { suite_id?: string; fee_asset_mode?: FeeAssetMode; quote: string; token: string; lp_fee: number; pool_fee_pips?: number; tick_spacing?: number; hook_address?: string | null }): PoolKey {
  if (l.suite_id !== undefined && !isSuiteId(l.suite_id)) throw new Error("Unknown launch suite");
  const hook = nonZeroAddress(l.hook_address);
  if (isQuoteFeeLaunch(l) && (l.pool_fee_pips !== 0 || !hook || !isQuoteHook(hook) || (l.tick_spacing ?? 200) !== 200)) throw new Error("Quote fee pool identity is incomplete");
  return { currency0: l.quote as Address, currency1: l.token as Address, fee: l.pool_fee_pips ?? l.lp_fee,
    tickSpacing: l.tick_spacing ?? 200, hooks: hook ?? NATIVE };
}
