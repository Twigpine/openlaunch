import type { Address, Hex, PublicClient } from "viem";
import { chainIdOf, isChainKey, type ChainKey } from "@/lib/chainPublic";

export type LaunchIdentity = { hash: Hex; chainId: number; sender: Address; nonce: number };
export type FirstBuyOutcome = { hash: Hex; status: "pending" | "confirmed" | "reverted" | "replaced"; symbol: string; amount?: string; exact?: boolean };
export type PendingLaunch = { chain: ChainKey; hash: Hex; token: string | null; identity?: LaunchIdentity; firstBuy?: FirstBuyOutcome };
export type SavedLaunch = PendingLaunch & { outcome: "indexed" | "nonce-finalized" | "reverted" };
const KEY = "ol:pending-launch";
const EMPTY: readonly SavedLaunch[] = [];
const listeners = new Set<() => void>();
let current: PendingLaunch | null = null;
let recent: readonly SavedLaunch[] = EMPTY;
let stored: string | null = null;
let inMemoryOnly = false;

const isHash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
const isAddress = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v);
function parseAttempt(v: unknown): PendingLaunch | null {
  if (!v || typeof v !== "object") return null;
  const a = v as PendingLaunch;
  if (!isChainKey(a.chain) || !isHash(a.hash)) return null;
  const attempt: PendingLaunch = { chain: a.chain, hash: a.hash, token: isAddress(a.token) ? a.token.toLowerCase() : null };
  const identity = a.identity;
  if (identity && identity.hash === a.hash && identity.chainId === chainIdOf(a.chain) && isAddress(identity.sender) && Number.isSafeInteger(identity.nonce) && identity.nonce >= 0) attempt.identity = identity;
  const buy = a.firstBuy;
  if (buy && isHash(buy.hash) && ["pending", "confirmed", "reverted", "replaced"].includes(buy.status) && typeof buy.symbol === "string" && buy.symbol.length <= 32) {
    attempt.firstBuy = { hash: buy.hash, status: buy.status, symbol: buy.symbol,
      ...(typeof buy.amount === "string" && /^\d{1,78}$/.test(buy.amount) ? { amount: buy.amount, exact: buy.exact === true } : {}) };
  }
  return attempt;
}
export function pendingLaunchServer(): null { return null; }
export function pendingLaunch(): PendingLaunch | null {
  if (inMemoryOnly) return current;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === stored) return current;
    stored = raw;
    const v = raw ? JSON.parse(raw) : null;
    // Version-one journals are the original single attempt; never invent missing nonce evidence.
    current = parseAttempt(v?.version === 2 ? v.active : v);
    recent = v?.version === 2 && Array.isArray(v.recent) ? v.recent.slice(0, 10).flatMap((row: SavedLaunch) => {
      const attempt = parseAttempt(row);
      return attempt && (row.outcome === "indexed" || row.outcome === "nonce-finalized" || row.outcome === "reverted") ? [{ ...attempt, outcome: row.outcome }] : [];
    }) : EMPTY;
  } catch { /* Storage denied: the in-memory attempt still prevents another send. */ }
  return current;
}
export function rememberPendingLaunch(attempt: PendingLaunch | null): void {
  current = attempt;
  persist();
}
function persist(): void {
  stored = current || recent.length ? JSON.stringify({ version: 2, active: current, recent }) : null;
  try {
    if (stored) sessionStorage.setItem(KEY, stored);
    else sessionStorage.removeItem(KEY);
    inMemoryOnly = false;
  } catch { inMemoryOnly = true; }
  for (const listener of listeners) listener();
}
export function recentLaunchesServer(): readonly SavedLaunch[] { return EMPTY; }
export function recentLaunches(): readonly SavedLaunch[] { pendingLaunch(); return recent; }
/** Keep the last ten session references without making an indexed/resolved attempt an active send guard. */
export function archivePendingLaunch(hash: Hex, outcome: SavedLaunch["outcome"], token?: string): boolean {
  const attempt = pendingLaunch();
  if (!attempt || attempt.hash.toLowerCase() !== hash.toLowerCase()) return false;
  recent = [{ ...attempt, token: token ?? attempt.token, outcome }, ...recent.filter((a) => a.hash !== attempt.hash || a.chain !== attempt.chain)].slice(0, 10);
  current = null;
  persist();
  return true;
}
export function rememberFirstBuy(launchHash: Hex, buy: FirstBuyOutcome): void {
  const attempt = pendingLaunch();
  if (attempt?.hash === launchHash) rememberPendingLaunch({ ...attempt, firstBuy: buy });
}

/** Best-effort evidence capture. Smart-wallet outer senders and unavailable transactions remain unresolvable here. */
export async function captureLaunchIdentity(pub: Pick<PublicClient, "getChainId" | "getTransaction">, chain: ChainKey, hash: Hex, wallet: Address): Promise<LaunchIdentity | undefined> {
  try {
    if (await pub.getChainId() !== chainIdOf(chain)) return;
    const tx = await pub.getTransaction({ hash });
    if (tx.hash.toLowerCase() !== hash.toLowerCase() || tx.from.toLowerCase() !== wallet.toLowerCase() || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0) return;
    return { hash, chainId: chainIdOf(chain), sender: tx.from, nonce: tx.nonce };
  } catch { return; }
}
/** Only a finalized nonce strictly past this exact saved transaction rules out its future execution. */
export async function launchNonceFinalized(pub: Pick<PublicClient, "getChainId" | "getTransactionCount">, attempt: PendingLaunch, wallet: Address): Promise<boolean> {
  const id = attempt.identity;
  if (!id || id.hash !== attempt.hash || id.chainId !== chainIdOf(attempt.chain) || id.sender.toLowerCase() !== wallet.toLowerCase() || !Number.isSafeInteger(id.nonce) || id.nonce < 0) return false;
  try {
    if (await pub.getChainId() !== id.chainId) return false;
    const nonce = await pub.getTransactionCount({ address: id.sender, blockTag: "finalized" });
    return Number.isSafeInteger(nonce) && nonce > id.nonce;
  } catch { return false; }
}
export function subscribePendingLaunch(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
