import type { Address } from "viem";
import type { ChainKey } from "../chainKeys.ts";
import { BASE_USDC } from "../bridge/types.ts";

/**
 * Earn: the lending vault a wallet can put its own USDC into from /me. CLIENT-SAFE and pure (node --test loads it).
 *
 * At most one reviewed vault per chain; a chain without one says null, so a new chain never inherits Base's vault.
 * `reviewed` is what the vault looked like on-chain when it was listed. Before every deposit the app reads the live
 * vault again and refuses the deposit if any of it changed (lib/earn/terms.ts). Withdrawals never depend on it.
 *
 * Funds go from the wallet straight into the vault and back. Openlaunch has no contract, key or fee in the path.
 */
export type EarnVault = {
  chain: ChainKey;
  /** The vault: an ERC-4626 share token (Morpho Vault V2). */
  address: Address;
  /** What it takes in and pays out. */
  asset: Address;
  assetSymbol: "USDC";
  assetDecimals: 6;
  /**
   * The storage slot of the asset's `allowed[owner][spender]` mapping. Used only to simulate a smart wallet's
   * [approve, deposit] batch before its one prompt (lib/earn/calls.ts approvedState). The app checks the override took
   * effect before trusting the simulation, so a wrong slot falls back to the one-at-a-time path instead of misleading.
   */
  assetAllowanceSlot: bigint;
  shareDecimals: 18;
  /** The vault's own on-chain name. */
  name: string;
  curator: string;
  curatorUrl: string;
  protocol: "Morpho";
  protocolUrl: string;
  /** The vault as listed: fees (WAD; 0 = none) and no gates. Checked live before each deposit. */
  reviewed: { performanceFee: bigint; managementFee: bigint; on: string };
};

/**
 * Steakhouse Prime USDC, a Morpho Vault V2 on Base, read on 2026-10-14: VaultV2Factory.isVaultV2 = true, asset = Circle's
 * Base USDC, performance and management fee 0, all four gates unset (anyone may deposit), about $182.6M deposited. It
 * is the vault Base's own "integrate an earn product" guide uses. A simulated 1,000 USDC deposit from a fresh address
 * succeeded, and a full deposit → partial withdraw → redeem-all cycle passed on a Base fork (docs/earn.md).
 */
const BASE_VAULT: EarnVault = {
  chain: "base",
  address: "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9",
  asset: BASE_USDC,
  assetSymbol: "USDC",
  assetDecimals: 6,
  // Circle FiatToken v2.2: `allowed` is mapping slot 10 (verified on a Base fork and by the opt-in live test)
  assetAllowanceSlot: 10n,
  shareDecimals: 18,
  name: "Steakhouse Prime USDC",
  curator: "Steakhouse Financial",
  curatorUrl: "https://www.steakhouse.financial",
  protocol: "Morpho",
  protocolUrl: "https://morpho.org",
  reviewed: { performanceFee: 0n, managementFee: 0n, on: "2026-10-14" },
};

export const EARN_VAULTS: Record<ChainKey, EarnVault | null> = { base: BASE_VAULT, robinhood: null, arc: null };

/** Morpho's VaultV2Factory on Base: `isVaultV2(vault)` proves a vault was deployed by it (the opt-in live test reads it). */
export const VAULT_V2_FACTORY_BASE: Address = "0x4501125508079A99ebBebCE205DeC9593C2b5857";

/** The chains that have a vault, in display order. */
export function earnChains(): ChainKey[] {
  return (Object.keys(EARN_VAULTS) as ChainKey[]).filter((c) => EARN_VAULTS[c] !== null);
}
