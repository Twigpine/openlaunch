import { isAddress, type Address } from "viem";
import type { ChainKey } from "../chainPublic";
// Explicit env accesses are required for Next.js to include these values in the client bundle.
export const QUOTE_CONFIG = {
  base: [process.env.NEXT_PUBLIC_QUOTE_FACTORY, process.env.NEXT_PUBLIC_QUOTE_LOCKER, process.env.NEXT_PUBLIC_QUOTE_VAULT, process.env.NEXT_PUBLIC_QUOTE_HOOK, process.env.NEXT_PUBLIC_QUOTE_DEPLOY_BLOCK, process.env.NEXT_PUBLIC_QUOTE_LAUNCH_ENABLED],
  robinhood: [process.env.NEXT_PUBLIC_QUOTE_FACTORY_ROBINHOOD, process.env.NEXT_PUBLIC_QUOTE_LOCKER_ROBINHOOD, process.env.NEXT_PUBLIC_QUOTE_VAULT_ROBINHOOD, process.env.NEXT_PUBLIC_QUOTE_HOOK_ROBINHOOD, process.env.NEXT_PUBLIC_QUOTE_DEPLOY_BLOCK_ROBINHOOD, process.env.NEXT_PUBLIC_QUOTE_LAUNCH_ENABLED_ROBINHOOD],
  arc: [process.env.NEXT_PUBLIC_QUOTE_FACTORY_ARC, process.env.NEXT_PUBLIC_QUOTE_LOCKER_ARC, process.env.NEXT_PUBLIC_QUOTE_VAULT_ARC, process.env.NEXT_PUBLIC_QUOTE_HOOK_ARC, process.env.NEXT_PUBLIC_QUOTE_DEPLOY_BLOCK_ARC, process.env.NEXT_PUBLIC_QUOTE_LAUNCH_ENABLED_ARC],
} as const;

/** A configured address: well-formed and not the zero address. */
export function nonZeroAddress(value: string | null | undefined): Address | null {
  const v = value?.trim();
  return v && isAddress(v) && BigInt(v) !== 0n ? (v as Address) : null;
}
/** A deployment block from configuration; 0 when unset or malformed. */
export function parseBlock(value: string | undefined): bigint {
  const v = value?.trim();
  return v && /^\d+$/.test(v) ? BigInt(v) : 0n;
}
/** QuoteFeeHook's permissions (HOOK_FLAGS in QuoteFeeHook.sol) are the low 14 bits of its address. */
export function isQuoteHook(hook: Address): boolean {
  return (BigInt(hook) & 0x3fffn) === 0x20ccn;
}

/** The chain's quote-only deployment from the environment, or null unless every address, the deploy block and the hook's permission bits are valid. */
export function quoteDeployment(chain: ChainKey, values: readonly (string | undefined)[] = QUOTE_CONFIG[chain]) {
  const [f, l, v, h, d, enabled] = values;
  const factory = nonZeroAddress(f), locker = nonZeroAddress(l), feeContract = nonZeroAddress(v), hook = nonZeroAddress(h);
  const deployBlock = parseBlock(d);
  if (!factory || !locker || !feeContract || !hook || deployBlock === 0n || !isQuoteHook(hook)) return null;
  return { factory, locker, feeContract, hook, deployBlock, launchEnabled: enabled === "true" };
}
