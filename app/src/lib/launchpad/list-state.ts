/** Shared list identity and request guards. Chain is part of every token identity. */
import { MCAP_POLICY_VERSION, type McapMode } from "./mcap-policy";

type ListSelection = { sort: string | null; window: string; chain?: string | null; filter?: string | null; limit?: number; mcap?: McapMode };
/** A rolling deploy or a previous selection must never silently supply an unfiltered market-cap page. */
export function matchesListSelection(wanted: ListSelection, received: ListSelection & { mcap_policy?: number }): boolean {
  return wanted.sort === received.sort && wanted.window === received.window &&
    (wanted.chain ?? null) === (received.chain ?? null) && (wanted.filter ?? null) === (received.filter ?? null) &&
    (received.limit === undefined || wanted.limit === received.limit) &&
    (wanted.sort !== "mcap" || ((wanted.mcap ?? "filtered") === received.mcap && received.mcap_policy === MCAP_POLICY_VERSION));
}

export function launchKey(row: { chain: string; token: string }): string {
  return `${row.chain}:${row.token.toLowerCase()}`;
}

export function mergeLaunches<T extends { chain: string; token: string }>(current: T[], incoming: T[]): T[] {
  const rows = new Map(current.map((row) => [launchKey(row), row]));
  for (const row of incoming) rows.set(launchKey(row), row);
  return [...rows.values()];
}

/** Update visible values without moving, removing, or inserting a pointer target. */
export function refreshInPlace<T extends { chain: string; token: string }>(current: T[], incoming: T[]): T[] {
  const fresh = new Map(incoming.map((row) => [launchKey(row), row]));
  return current.map((row) => fresh.get(launchKey(row)) ?? row);
}
