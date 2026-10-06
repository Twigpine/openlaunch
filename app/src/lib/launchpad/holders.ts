/**
 * Pure holder / trust-panel logic (node --test loads this directly).
 * Balances come from ERC-20 Transfer events of launched tokens; nothing here trusts anything off-chain.
 */
export const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
export const DEAD_ADDR = "0x000000000000000000000000000000000000dead";
/** Buys in the launch block and the next SNIPER_BLOCKS blocks count as sniping. */
export const SNIPER_BLOCKS = 3;
export const TOP_HOLDERS = 10;
/** Persisted bigint-max marker: transfer history is complete and the live loop keeps it current. */
export const SYNCED_FOREVER = 9223372036854775807n;
/** A single wallet above this share of supply is flagged in the panel. */
export const WHALE_BPS = 500; // 5%

export type HolderTag = "creator" | "pool" | "burn" | "sniper" | "whale";
/** `system` = addresses that hold tokens on the protocol's behalf and never count as holders: PoolManager, PositionManager, locker, factory. */
export type HolderCtx = { launcher: string; system: string[]; snipers?: Set<string> };

/** Apply one transfer to a balance map (mint from zero / burn to zero handled naturally). Pure; used by tests and the indexer's dry-run. */
export function applyTransfer(balances: Map<string, bigint>, from: string, to: string, value: bigint): void {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  if (f !== ZERO_ADDR) balances.set(f, (balances.get(f) ?? 0n) - value);
  if (t !== ZERO_ADDR) balances.set(t, (balances.get(t) ?? 0n) + value);
}

/** Addresses that never count as holders: protocol contracts (pool, position manager, locker, factory) and burn sinks. */
export function isNonHolder(address: string, ctx: Pick<HolderCtx, "system">): boolean {
  const a = address.toLowerCase();
  return a === ZERO_ADDR || a === DEAD_ADDR || ctx.system.some((x) => x.toLowerCase() === a);
}

/** Basis points of supply for a balance (0 when supply is 0). */
export function shareBps(balance: bigint, supply: bigint): number {
  if (supply <= 0n || balance <= 0n) return 0;
  return Number((balance * 10_000n) / supply);
}

export function fmtShare(bps: number): string {
  if (bps <= 0) return "0%";
  if (bps < 1) return "<0.01%";
  const pct = bps / 100;
  return `${pct >= 10 ? pct.toFixed(0) : pct >= 1 ? pct.toFixed(1) : pct.toFixed(2)}%`;
}

/** Tags for a holder row, most important first. */
export function holderTags(address: string, balance: bigint, supply: bigint, ctx: HolderCtx): HolderTag[] {
  const a = address.toLowerCase();
  const tags: HolderTag[] = [];
  if (a === ctx.launcher.toLowerCase()) tags.push("creator");
  if (ctx.system.some((x) => x.toLowerCase() === a)) tags.push("pool");
  if (a === ZERO_ADDR || a === DEAD_ADDR) tags.push("burn");
  if (ctx.snipers?.has(a)) tags.push("sniper");
  if (!tags.includes("pool") && !tags.includes("burn") && shareBps(balance, supply) >= WHALE_BPS) tags.push("whale");
  return tags;
}

/** Is a swap inside the sniper window for a launch? */
export function inSniperWindow(launchBlock: bigint | number, swapBlock: bigint | number, blocks = SNIPER_BLOCKS): boolean {
  return BigInt(swapBlock) >= BigInt(launchBlock) && BigInt(swapBlock) <= BigInt(launchBlock) + BigInt(blocks);
}

/** `trader` is null when the indexer could not read the transaction sender (RPC failure); such swaps carry no wallet facts. */
export type SwapLite = { trader: string | null; is_buy: boolean; block_number: bigint | number; token_amount: bigint };

/** Sniper summary from a token's swaps: wallets that bought inside the window and how much of supply they took. */
export function sniperSummary(swaps: SwapLite[], launchBlock: bigint | number, supply: bigint): { wallets: string[]; boughtBps: number } {
  const per = new Map<string, bigint>();
  for (const s of swaps) {
    if (!s.trader || !s.is_buy || !inSniperWindow(launchBlock, s.block_number)) continue;
    const t = s.trader.toLowerCase();
    per.set(t, (per.get(t) ?? 0n) + (s.token_amount < 0n ? -s.token_amount : s.token_amount));
  }
  let total = 0n;
  for (const v of per.values()) total += v;
  return { wallets: [...per.keys()], boughtBps: shareBps(total, supply) };
}

/** What the creator has bought and sold of their own token (raw token units). */
export function creatorActivity(swaps: SwapLite[], launcher: string): { bought: bigint; sold: bigint; sells: number } {
  const l = launcher.toLowerCase();
  let bought = 0n, sold = 0n, sells = 0;
  for (const s of swaps) {
    if (!s.trader || s.trader.toLowerCase() !== l) continue;
    const amt = s.token_amount < 0n ? -s.token_amount : s.token_amount;
    if (s.is_buy) bought += amt;
    else {
      sold += amt;
      sells++;
    }
  }
  return { bought, sold, sells };
}

/** One-line verdicts for the panel header, worst first. Facts only, no score. */
export function trustNotes(p: { holders: number; creatorBps: number; creatorSells: number; sniperBps: number; sniperWallets: number; top10Bps: number; poolBps: number }): { level: "warn" | "info" | "good"; text: string }[] {
  const out: { level: "warn" | "info" | "good"; text: string }[] = [];
  if (p.creatorBps >= 2000) out.push({ level: "warn", text: `Creator holds ${fmtShare(p.creatorBps)} of supply` });
  else if (p.creatorBps > 0) out.push({ level: "info", text: `Creator holds ${fmtShare(p.creatorBps)}` });
  if (p.creatorSells > 0) out.push({ level: "warn", text: `Creator sold ${p.creatorSells} time${p.creatorSells === 1 ? "" : "s"}` });
  if (p.sniperBps >= 1000) out.push({ level: "warn", text: `${p.sniperWallets} wallet${p.sniperWallets === 1 ? "" : "s"} sniped ${fmtShare(p.sniperBps)} at launch` });
  else if (p.sniperWallets > 0) out.push({ level: "info", text: `${p.sniperWallets} early buyer${p.sniperWallets === 1 ? "" : "s"} took ${fmtShare(p.sniperBps)} at launch` });
  if (p.top10Bps >= 5000) out.push({ level: "warn", text: `Top 10 wallets hold ${fmtShare(p.top10Bps)}` });
  out.push({ level: "good", text: `${fmtShare(p.poolBps)} of supply sits in the locked pool` });
  if (out.every((n) => n.level !== "warn")) out.unshift({ level: "good", text: `${p.holders} holder${p.holders === 1 ? "" : "s"}, no red flags` });
  return out;
}
