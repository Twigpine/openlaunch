import "server-only";
import type { PublicClient } from "viem";
import { publicClient } from "@/lib/chain";
import { memo } from "@/lib/launchpad/memo";
import type { ChainKey } from "@/lib/chainPublic";
import { EARN_VAULT_ABI } from "./abi";
import { RATE_WINDOW_S, SHARE_PRICE_PROBE, annualisedRate, managementFeeYearPct, wadPct } from "./math";
import { readTerms, termsCheck } from "./terms";
import { EARN_VAULTS, earnChains, type EarnVault } from "./vaults";
import type { EarnInfo, EarnVaultSnapshot } from "./info";

/**
 * Server half of Earn. The feature is OFF unless the runtime secret EARN=on is set (`fly secrets set EARN=on`, which
 * restarts the app; no rebuild). Off, the API says only `{ enabled: false }` and the /me card and ⌘K entry stay hidden.
 * Setting it back to anything else is the kill switch.
 */
export function earnEnabled(): boolean {
  return process.env.EARN?.trim().toLowerCase() === "on";
}

/** Rough block times, to find the block about 30 days back; the rate itself uses the two blocks' real timestamps. */
const BLOCK_TIME_S: Record<ChainKey, number> = { base: 2, robinhood: 0.1, arc: 0.5 };
/** The vault's figures move slowly and every visitor sees the same ones: one read per 10 minutes per vault. */
const SNAPSHOT_TTL_MS = 10 * 60_000;

type Reader = Pick<PublicClient, "getBlock" | "readContract">;

/**
 * One vault's public figures, all read at the same block: assets, fees, gates (against the reviewed terms) and the share
 * price now and about 30 days back. The rate is what a share actually gained, net of the vault's fees, with no third
 * party involved. The older read needs a node that serves historical state; when it fails the rate is null, never an
 * error. Only a failure of the current reads rejects.
 */
export async function readSnapshot(vault: EarnVault, client: Reader): Promise<EarnVaultSnapshot> {
  const latest = await client.getBlock();
  const at = { address: vault.address, abi: EARN_VAULT_ABI, blockNumber: latest.number } as const;
  const [terms, totalAssets, price] = await Promise.all([
    readTerms(client, vault, latest.number),
    client.readContract({ ...at, functionName: "totalAssets" }),
    client.readContract({ ...at, functionName: "convertToAssets", args: [SHARE_PRICE_PROBE] }),
  ]);
  const back = latest.number - BigInt(Math.round(RATE_WINDOW_S / BLOCK_TIME_S[vault.chain]));
  const earlier = back > 0n
    ? await Promise.all([
        client.getBlock({ blockNumber: back }),
        client.readContract({ ...at, blockNumber: back, functionName: "convertToAssets", args: [SHARE_PRICE_PROBE] }),
      ]).then(([block, p]) => ({ time: Number(block.timestamp), price: p }), () => null)
    : null;
  const now = Number(latest.timestamp);
  return {
    rate: earlier ? annualisedRate(earlier.price, price, now - earlier.time) : null,
    rateFrom: earlier ? new Date(earlier.time * 1000).toISOString() : null,
    rateTo: new Date(now * 1000).toISOString(),
    totalAssets: totalAssets.toString(),
    performanceFeePct: wadPct(terms.performanceFee),
    managementFeeYearPct: managementFeeYearPct(terms.managementFee),
    terms: termsCheck(vault, terms),
  };
}

/** The memoised snapshot for a chain's vault; null when the chain has none or the chain could not be read. */
export async function earnSnapshot(chain: ChainKey, client?: Reader): Promise<EarnVaultSnapshot | null> {
  const vault = EARN_VAULTS[chain];
  if (!vault) return null;
  try {
    return await memo(`earn:snapshot:${chain}`, SNAPSHOT_TTL_MS, () => readSnapshot(vault, client ?? publicClient(chain)));
  } catch (err) {
    console.warn(`[earn] ${chain} vault read failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** What GET /api/earn returns when the feature is on. */
export async function earnInfo(client?: Reader): Promise<EarnInfo> {
  const vaults = await Promise.all(earnChains().map(async (chain) => ({ chain, address: EARN_VAULTS[chain]!.address, snapshot: await earnSnapshot(chain, client) })));
  return { enabled: true, vaults };
}
