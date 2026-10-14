import type { ChainKey } from "../chainKeys.ts";
import type { TermsCheck } from "./terms.ts";

/**
 * GET /api/earn's answer (client-safe types). Off: `{ enabled: false }` and nothing else, so a switched-off feature
 * leaks nothing. On: per vault, figures read from the chain by the server, or `snapshot: null` when it could not read
 * them (the card then shows its deposit and withdrawal controls without a rate).
 */
export type EarnVaultSnapshot = {
  /** What the vault paid over about the last 30 days, simple annual rate; null when the older read was unavailable. */
  rate: number | null;
  /** ISO times of the two share-price reads the rate is measured between. */
  rateFrom: string | null;
  rateTo: string;
  /** Assets in the vault, raw units of its asset (a string: JSON has no bigint). */
  totalAssets: string;
  performanceFeePct: number;
  managementFeeYearPct: number;
  /** The live vault against what was reviewed (lib/earn/terms.ts). The browser checks again before each deposit. */
  terms: TermsCheck;
};

export type EarnInfoVault = { chain: ChainKey; address: string; snapshot: EarnVaultSnapshot | null };

export type EarnInfo = { enabled: false } | { enabled: true; vaults: EarnInfoVault[] };
