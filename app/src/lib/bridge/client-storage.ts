import type { Address } from "viem";
import { clientTranslator } from "@/i18n/client";
import { parseStoredTransfer, serializeTransfer, transferIsTerminal, type TrackedBridgeTransfer } from "./client";

export const BRIDGE_STORAGE_PREFIX = "openlaunch.bridge.v1:";
type StorageAdapter = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type TransferSnapshot = { transfers: Record<string, TrackedBridgeTransfer | null>; errors: Record<string, string | null> };
const EMPTY: TransferSnapshot = { transfers: {}, errors: {} };
export const bridgeStorageKey = (address: Address) => `${BRIDGE_STORAGE_PREFIX}${address.toLowerCase()}`;

/** Injectable storage adapter, with stable snapshots for useSyncExternalStore. */
export function createBridgeTransferStore(storage: () => StorageAdapter) {
  let snapshot = EMPTY;
  const listeners = new Set<() => void>();
  function update(address: Address, transfer: TrackedBridgeTransfer | null, error: string | null) {
    const key = address.toLowerCase();
    snapshot = { transfers: { ...snapshot.transfers, [key]: transfer }, errors: { ...snapshot.errors, [key]: error } };
    for (const notify of listeners) notify();
  }
  return {
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    remember(transfer: TrackedBridgeTransfer) {
      update(transfer.address, transfer, snapshot.errors[transfer.address.toLowerCase()] ?? null);
    },
    read(address: Address): TrackedBridgeTransfer | null {
      try {
        const raw = storage().getItem(bridgeStorageKey(address));
        let transfer = raw === null ? null : parseStoredTransfer(raw, address);
        const memory = snapshot.transfers[address.toLowerCase()];
        if (transfer && memory?.requestId === transfer.requestId) {
          // The pre-send record can be older than memory if the subsequent
          // source-hash write failed. Do not discard that known transaction.
          const advanced = transferIsTerminal(memory) || (!transferIsTerminal(transfer) && memory.sourceHash && !transfer.sourceHash);
          transfer = { ...transfer, ...(advanced ? { status: memory.status, ...(memory.failureReason ? { failureReason: memory.failureReason } : {}) } : {}), sourceHash: memory.sourceHash ?? transfer.sourceHash, destinationHashes: [...new Set([...transfer.destinationHashes, ...memory.destinationHashes])] };
        }
        update(address, transfer, null);
        return transfer;
      } catch {
        const message = clientTranslator("bridge")("errors.storageUnreadable");
        update(address, snapshot.transfers[address.toLowerCase()] ?? null, message);
        throw new Error(message);
      }
    },
    save(transfer: TrackedBridgeTransfer) {
      try {
        const raw = serializeTransfer(transfer);
        const adapter = storage();
        adapter.setItem(bridgeStorageKey(transfer.address), raw);
        if (adapter.getItem(bridgeStorageKey(transfer.address)) !== raw) throw new Error("Storage did not retain transfer");
        update(transfer.address, transfer, null);
      } catch {
        const message = clientTranslator("bridge")("errors.storageNotSaved");
        update(transfer.address, transfer, message);
        throw new Error(message);
      }
    },
    remove(address: Address) {
      try {
        storage().removeItem(bridgeStorageKey(address));
        update(address, null, null);
      } catch {
        const message = clientTranslator("bridge")("errors.storageNotCleared");
        update(address, snapshot.transfers[address.toLowerCase()] ?? null, message);
        throw new Error(message);
      }
    },
  };
}
