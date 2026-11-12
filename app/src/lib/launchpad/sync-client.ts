import type { Hex } from "viem";
import type { ChainKey } from "@/lib/chainPublic";

export type TransactionSync = { status: "applied"; tokens: string[] } | { status: "pending" | "reverted" | "error" };

/** Index an already sent transaction. Indexer availability never changes the wallet's send outcome. */
export async function syncTransaction(chain: ChainKey, hash: Hex, signal?: AbortSignal): Promise<TransactionSync> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`/api/launch/sync?chain=${chain}&tx=${hash}`, { method: "POST", signal: controller.signal });
    if (!response.ok) return { status: "error" };
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("status" in body)) return { status: "error" };
    if (body.status === "applied") return { status: "applied", tokens: "tokens" in body && Array.isArray(body.tokens) ? body.tokens.filter((t): t is string => typeof t === "string" && /^0x[0-9a-f]{40}$/i.test(t)).map((t) => t.toLowerCase()) : [] };
    if (body.status === "reverted") return { status: "reverted" };
    if (body.status === "not_found" || body.status === "pending" || body.status === "skipped") return { status: "pending" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export const INDEX_PENDING_COPY = "Transaction sent. The page is still updating; check its transaction before sending again.";
