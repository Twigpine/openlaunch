import type { Address, Hex } from "viem";
import type { TrackedBridgeTransfer } from "./client";
import { historyFromTransfer, parseHistoryLedger, serializeHistoryLedger, upsertHistory, type BridgeHistoryEntry } from "./history";

/**
 * This browser's bridge history: a ledger kept beside the recovery record, never instead of it. The recovery record
 * (client-storage.ts) guards against sending twice and is cleared when a transfer is done; this one only remembers.
 * It is best effort by design: a storage failure here is reported, never thrown into a transfer.
 */
export const BRIDGE_HISTORY_PREFIX = "openlaunch.bridge.history.v1:";
export const bridgeHistoryKey = (address: Address | string) => `${BRIDGE_HISTORY_PREFIX}${address.toLowerCase()}`;
type StorageAdapter = Pick<Storage, "getItem" | "setItem">;
export type HistorySnapshot = { entries: Record<string, BridgeHistoryEntry[]>; unsaved: Record<string, boolean> };
const EMPTY: HistorySnapshot = { entries: {}, unsaved: {} };

export function createBridgeHistoryStore(storage: () => StorageAdapter) {
  let snapshot = EMPTY;
  const listeners = new Set<() => void>();
  function update(wallet: string, entries: BridgeHistoryEntry[], unsaved: boolean) {
    const current = snapshot.entries[wallet];
    if (current && snapshot.unsaved[wallet] === unsaved && serializeHistoryLedger(current) === serializeHistoryLedger(entries)) return;
    snapshot = { entries: { ...snapshot.entries, [wallet]: entries }, unsaved: { ...snapshot.unsaved, [wallet]: unsaved } };
    for (const notify of listeners) notify();
  }
  function load(wallet: string): BridgeHistoryEntry[] {
    const raw = storage().getItem(bridgeHistoryKey(wallet));
    if (raw === null) return [];
    try { return parseHistoryLedger(raw); } catch { return []; }
  }
  function write(wallet: string, entries: BridgeHistoryEntry[]) {
    try {
      storage().setItem(bridgeHistoryKey(wallet), serializeHistoryLedger(entries));
      update(wallet, entries, false);
    } catch { update(wallet, entries, true); }
  }
  return {
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    /** Re-read from storage, keeping rows only memory has (a write that failed) so nothing seen is lost. */
    read(address: Address): BridgeHistoryEntry[] {
      const wallet = address.toLowerCase();
      let stored: BridgeHistoryEntry[];
      try { stored = load(wallet); } catch { update(wallet, snapshot.entries[wallet] ?? [], true); return snapshot.entries[wallet] ?? []; }
      let rows = stored;
      for (const entry of snapshot.entries[wallet] ?? []) rows = upsertHistory(rows, entry);
      update(wallet, rows, snapshot.unsaved[wallet] ?? false);
      return rows;
    },
    /** Remember a tracked transfer once it has left the wallet; a no-op until then and when nothing changed. */
    record(transfer: TrackedBridgeTransfer, quotedOut: string | null = null) {
      const entry = historyFromTransfer(transfer, quotedOut);
      if (!entry) return;
      const wallet = transfer.address.toLowerCase();
      let base: BridgeHistoryEntry[];
      try { base = load(wallet); } catch { base = []; }
      for (const row of snapshot.entries[wallet] ?? []) base = upsertHistory(base, row);
      const next = upsertHistory(base, entry);
      if (snapshot.entries[wallet] && !snapshot.unsaved[wallet] && serializeHistoryLedger(next) === serializeHistoryLedger(snapshot.entries[wallet])) return;
      write(wallet, next);
    },
    /** Drop a row for a transfer that was discarded because it never left the wallet. */
    forget(address: Address, requestId: Hex) {
      const wallet = address.toLowerCase();
      let base: BridgeHistoryEntry[];
      try { base = load(wallet); } catch { base = snapshot.entries[wallet] ?? []; }
      const next = base.filter((row) => row.requestId.toLowerCase() !== requestId.toLowerCase());
      if (next.length !== base.length || (snapshot.entries[wallet] ?? []).some((row) => row.requestId.toLowerCase() === requestId.toLowerCase())) write(wallet, next);
    },
  };
}
