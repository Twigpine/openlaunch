import type { Hex } from "viem";
import { isChainKey, type ChainKey } from "@/lib/chainPublic";

export type PendingLaunch = { chain: ChainKey; hash: Hex; token: string | null };
const KEY = "ol:pending-launch";
const listeners = new Set<() => void>();
let current: PendingLaunch | null = null;
let stored: string | null = null;
let inMemoryOnly = false;

export function pendingLaunchServer(): null { return null; }
export function pendingLaunch(): PendingLaunch | null {
  if (inMemoryOnly) return current;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === stored) return current;
    stored = raw;
    const v = raw ? JSON.parse(raw) : null;
    current = v && isChainKey(v.chain) && typeof v.hash === "string" && /^0x[0-9a-f]{64}$/i.test(v.hash)
      ? { chain: v.chain, hash: v.hash, token: typeof v.token === "string" && /^0x[0-9a-f]{40}$/i.test(v.token) ? v.token.toLowerCase() : null } : null;
  } catch { /* Storage denied: the in-memory attempt still prevents another send. */ }
  return current;
}
export function rememberPendingLaunch(attempt: PendingLaunch | null): void {
  current = attempt;
  stored = attempt ? JSON.stringify(attempt) : null;
  try {
    if (stored) sessionStorage.setItem(KEY, stored);
    else sessionStorage.removeItem(KEY);
    inMemoryOnly = false;
  } catch { inMemoryOnly = true; }
  for (const listener of listeners) listener();
}
export function subscribePendingLaunch(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
