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

type TrustInput = { holders: number; creatorBps: number; creatorSells: number; sniperBps: number; sniperWallets: number; top10Bps: number; poolBps: number };

/**
 * A trust note as data: which fact it states, how it reads (warn, info, good) and its figures (`share` is already
 * formatted). `trustNotes` words these in English for the holders API; the holders panel words them in the reader's language.
 */
export type TrustNote = {
  level: "warn" | "info" | "good";
  key: "creatorHoldsSupply" | "creatorHolds" | "creatorSold" | "sniped" | "earlyBuyers" | "top10" | "pool" | "clean";
  count: number;
  share: string;
};

/** The panel header's notes, worst first. Facts only, no score; with nothing to flag, `clean` leads. */
export function trustNoteFacts(p: TrustInput): TrustNote[] {
  const out: TrustNote[] = [];
  const note = (level: TrustNote["level"], key: TrustNote["key"], figures: { count?: number; share?: string }) => out.push({ level, key, count: figures.count ?? 0, share: figures.share ?? "" });
  if (p.creatorBps >= 2000) note("warn", "creatorHoldsSupply", { share: fmtShare(p.creatorBps) });
  else if (p.creatorBps > 0) note("info", "creatorHolds", { share: fmtShare(p.creatorBps) });
  if (p.creatorSells > 0) note("warn", "creatorSold", { count: p.creatorSells });
  if (p.sniperBps >= 1000) note("warn", "sniped", { count: p.sniperWallets, share: fmtShare(p.sniperBps) });
  else if (p.sniperWallets > 0) note("info", "earlyBuyers", { count: p.sniperWallets, share: fmtShare(p.sniperBps) });
  if (p.top10Bps >= 5000) note("warn", "top10", { share: fmtShare(p.top10Bps) });
  note("good", "pool", { share: fmtShare(p.poolBps) });
  if (out.every((n) => n.level !== "warn")) out.unshift({ level: "good", key: "clean", count: p.holders, share: "" });
  return out;
}

const s = (n: number) => (n === 1 ? "" : "s");
/** Each note in English, as the holders API words it. */
const ENGLISH: Record<TrustNote["key"], (n: TrustNote) => string> = {
  creatorHoldsSupply: (n) => `Creator holds ${n.share} of supply`,
  creatorHolds: (n) => `Creator holds ${n.share}`,
  creatorSold: (n) => `Creator sold ${n.count} time${s(n.count)}`,
  sniped: (n) => `${n.count} wallet${s(n.count)} sniped ${n.share} at launch`,
  earlyBuyers: (n) => `${n.count} early buyer${s(n.count)} took ${n.share} at launch`,
  top10: (n) => `Top 10 wallets hold ${n.share}`,
  pool: (n) => `${n.share} of supply sits in the locked pool`,
  clean: (n) => `${n.count} holder${s(n.count)}, no red flags`,
};

/** One-line verdicts for the panel header, worst first, in English (the holders API's wording). Facts only, no score. */
export function trustNotes(p: TrustInput): { level: "warn" | "info" | "good"; text: string }[] {
  return trustNoteFacts(p).map((n) => ({ level: n.level, text: ENGLISH[n.key](n) }));
}
