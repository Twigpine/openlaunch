import { chainIdOf, type ChainKey } from "@/lib/chainPublic";
import { CONFIGURED_CHAINS, launchpad, type ChainLaunchpad } from "./config";
import { DEAD_ADDR, ZERO_ADDR } from "./holders";

/** One source for the live indexer, holder panel and offline holder rebuild. */
export function systemAddresses(chain: ChainKey): string[] {
  return systemAddressesOf(launchpad(chain));
}

export function systemAddressesOf(cfg: ChainLaunchpad): string[] {
  if (!cfg.factory || !cfg.locker) throw new Error(`holder exclusions require a configured ${cfg.key} factory and locker`);
  return [...new Set([cfg.v4.poolManager, cfg.v4.positionManager, cfg.locker, cfg.factory, cfg.v4.universalRouter, cfg.v4.permit2]
    .map((value) => value.toLowerCase()))];
}

export function holderExclusionsByChain(): Record<string, string[]> {
  return Object.fromEntries(CONFIGURED_CHAINS.map((chain) => [chainIdOf(chain), [...systemAddresses(chain), ZERO_ADDR, DEAD_ADDR]]));
}

/** Emit public address configuration only. SQL is reviewed/executed separately by the operator. */
export function holderRebuildSql(sql: string, exclusions: Record<string, readonly string[]>): string {
  const entries = Object.entries(exclusions);
  if (entries.length === 0 || entries.some(([cid, addresses]) => !/^[1-9]\d*$/.test(cid) || !Number.isSafeInteger(Number(cid))
    || addresses.length === 0 || addresses.some((value) => !/^0x[0-9a-f]{40}$/i.test(value)))) {
    throw new Error("holder rebuild requires valid configured chain IDs and address lists");
  }
  const normalized = Object.fromEntries(entries.map(([cid, values]) => [cid, [...new Set(values.map((value) => value.toLowerCase()))]]));
  // The strict address/chain validation excludes SQL delimiters; escape anyway to keep this boundary explicit.
  const json = JSON.stringify(normalized).replaceAll("'", "''");
  return `-- Generated holder exclusions from the application's public chain configuration.\nSELECT set_config('openlaunch.holder_exclusions', '${json}', false);\n${sql}`;
}
