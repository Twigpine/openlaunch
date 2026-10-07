/**
 * Who made a swap. The indexer stores the transaction sender, which is the trader for every wallet that sends its
 * own transactions. It is not for ERC-4337 smart wallets (Coinbase / Base App: tx.from is the bundler) or relayed
 * EIP-7702 calls (tx.from is the relayer). Rule: when the sender neither received nor sent the launched token in
 * that transaction, the trader is the wallet that did: for a buy, the end of the chain of transfers that starts at
 * the PoolManager; for a sell, the start of the chain that ends there. Pure; the indexer feeds it the token's
 * Transfer legs of one transaction (bb_token_transfers).
 */

export type Leg = { log_index: number; from_addr: string; to_addr: string };

/** Hops followed before giving up (a router forwarding to the user is 1; nothing legitimate needs more than a few). */
export const MAX_HOPS = 6;

/**
 * The wallet to credit for one swap, or null to keep the sender. `system` lists addresses that never count as a
 * trader (PoolManager, routers, Permit2, locker, factory); the PoolManager must be in it.
 */
export function attributeSwap(p: { legs: readonly Leg[]; txFrom: string; isBuy: boolean; swapLogIndex: number; poolManager: string; system: readonly string[] }): string | null {
  const from = p.txFrom.toLowerCase();
  const pm = p.poolManager.toLowerCase();
  const system = new Set(p.system.map((a) => a.toLowerCase()));
  system.add(pm);
  const legs = [...p.legs].map((l) => ({ log_index: l.log_index, from_addr: l.from_addr.toLowerCase(), to_addr: l.to_addr.toLowerCase() })).sort((a, b) => a.log_index - b.log_index);
  if (legs.length === 0) return null;
  // the sender moved the token itself: it is the trader (the common case, nothing to change)
  if (legs.some((l) => l.from_addr === from || l.to_addr === from)) return null;
  const nearest = (cands: typeof legs) => [...cands].sort((a, b) => Math.abs(a.log_index - p.swapLogIndex) - Math.abs(b.log_index - p.swapLogIndex))[0];
  if (p.isBuy) {
    const start = nearest(legs.filter((l) => l.from_addr === pm));
    if (!start) return null;
    let cur = start;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const next = legs.find((l) => l.log_index > cur.log_index && l.from_addr === cur.to_addr);
      if (!next) break;
      cur = next;
    }
    return system.has(cur.to_addr) ? null : cur.to_addr;
  }
  const end = nearest(legs.filter((l) => l.to_addr === pm));
  if (!end) return null;
  let cur = end;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const prev = [...legs].reverse().find((l) => l.log_index < cur.log_index && l.to_addr === cur.from_addr);
    if (!prev) break;
    cur = prev;
  }
  return system.has(cur.from_addr) ? null : cur.from_addr;
}
