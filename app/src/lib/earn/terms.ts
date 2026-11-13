import { zeroAddress, type Address, type PublicClient } from "viem";
import type { EarnVault } from "./vaults.ts";
import { EARN_VAULT_ABI, VAULT_GATES } from "./abi.ts";
import { fmtFeePct, managementFeeYearPct, wadPct } from "./math.ts";

/**
 * The deposit tripwire (pure). A vault's owner and curator can change its fees and gates, some of them with no delay
 * (Coinbase's own High Yield vault can raise its performance fee instantly). The vault was listed as it was on the
 * review date; if the live vault differs in any way that costs or restricts a depositor, deposits here stop with a
 * plain reason until someone reviews it again. Withdrawals never go through this check.
 */
export type LiveTerms = { asset: Address; performanceFee: bigint; managementFee: bigint; gates: readonly Address[] };
export type TermsCheck = { ok: true } | { ok: false; reason: string };

/** Whether the live vault still matches what was reviewed; the first difference found is the reason. */
export function termsCheck(vault: EarnVault, live: LiveTerms): TermsCheck {
  if (live.asset.toLowerCase() !== vault.asset.toLowerCase()) return { ok: false, reason: `The vault no longer takes ${vault.assetSymbol}.` };
  if (live.performanceFee > vault.reviewed.performanceFee) return { ok: false, reason: `The vault now keeps ${fmtFeePct(wadPct(live.performanceFee))} of the interest it earns.` };
  if (live.managementFee > vault.reviewed.managementFee) return { ok: false, reason: `The vault now charges a ${fmtFeePct(managementFeeYearPct(live.managementFee))} yearly management fee.` };
  if (live.gates.some((g) => g.toLowerCase() !== zeroAddress)) return { ok: false, reason: "The vault now restricts who may use it." };
  return { ok: true };
}

/** The live terms, read in one go (at one block when given): the server's snapshot and the browser's pre-deposit check. */
export async function readTerms(client: Pick<PublicClient, "readContract">, vault: EarnVault, blockNumber?: bigint): Promise<LiveTerms> {
  const at = { address: vault.address, abi: EARN_VAULT_ABI, blockNumber } as const;
  const [asset, performanceFee, managementFee, gates] = await Promise.all([
    client.readContract({ ...at, functionName: "asset" }),
    client.readContract({ ...at, functionName: "performanceFee" }),
    client.readContract({ ...at, functionName: "managementFee" }),
    Promise.all(VAULT_GATES.map((g) => client.readContract({ ...at, functionName: g }))),
  ]);
  return { asset, performanceFee, managementFee, gates };
}

/** The seven polled reads, in the order the card asks for them. */
export type PolledTerms = readonly [Address, bigint, bigint, Address, Address, Address, Address];

/**
 * The browser's polled read as a terms check, or null when there is none to trust: not read yet, or the latest poll
 * failed. A failed refetch keeps the last good data around (wagmi documents `data` as the last success), and that older
 * read must not outrank the server's check.
 */
export function liveCheck(vault: EarnVault, data: PolledTerms | undefined, failed: boolean): TermsCheck | null {
  if (!data || failed) return null;
  return termsCheck(vault, { asset: data[0], performanceFee: data[1], managementFee: data[2], gates: [data[3], data[4], data[5], data[6]] });
}

/**
 * Why deposits are paused right now, or null. The browser's own read of the vault (re-read every minute while the card
 * is open) wins over the server's figures, which can be up to 10 minutes old; until it arrives the server's stand.
 * Derived on every render, never stored, so a pause lifts by itself once the vault is back to the reviewed terms.
 */
export function depositPause(live: TermsCheck | null, server: TermsCheck | null): string | null {
  const t = live ?? server;
  return t && !t.ok ? t.reason : null;
}

/** The sentence under a paused deposit form. */
export function pausedCopy(reason: string): string {
  return `Deposits are paused here: ${reason} openlaunch listed this vault without that and has not reviewed the change. Withdrawals stay open.`;
}
