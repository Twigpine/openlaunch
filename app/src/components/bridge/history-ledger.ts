import { createBridgeHistoryStore } from "@/lib/bridge/history-store";

/** The one history ledger, shared by the bridge controller (which writes it) and the history board (which reads it). */
export const bridgeLedger = createBridgeHistoryStore(() => window.localStorage);
