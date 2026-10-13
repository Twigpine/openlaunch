/** Pure search / filter helpers (client + server; node --test loads this directly). */
import { newestFirst } from "./paging";
import { CHAIN_KEYS, type ChainKey } from "../chainKeys.ts";
import { GITLAWB_ADDRESSES } from "./gitlawb.ts";
import { TWIG_ADDRESSES } from "./twig.ts";
export type LaunchFilter = "fee0" | "burn" | "usdg" | "usdc" | "twig" | "gitlawb" | "today";
/** `chains`: the filter only makes sense on those chains (its quote is not offered elsewhere) → hidden when another chain is selected. */
export const FILTERS: { key: LaunchFilter; label: string; title: string; chains?: ChainKey[] }[] = [
  { key: "fee0", label: "0% fee", title: "feeless pools" },
  { key: "burn", label: "fees burned", title: "no beneficiary; every fee is burned" },
  { key: "usdg", label: "USDG", title: "priced in USDG (Robinhood Chain)", chains: ["robinhood"] },
  { key: "usdc", label: "USDC", title: "priced in USDC (Arc)", chains: ["arc"] },
  { key: "twig", label: "TWIG", title: "priced in TWIG, the 1:1 wrapper of GITLAWB (Base)", chains: CHAIN_KEYS.filter((k) => TWIG_ADDRESSES[k] !== null) },
  { key: "gitlawb", label: "GITLAWB", title: "priced in GITLAWB (Base or Robinhood Chain)", chains: CHAIN_KEYS.filter((k) => GITLAWB_ADDRESSES[k] !== null) },
  { key: "today", label: "today", title: "launched in the last 24 hours" },
];
/** Whether a filter is offered with `chain` selected (null = all chains: every filter). */
export function filterOnChain(f: { chains?: ChainKey[] }, chain: ChainKey | null): boolean {
  return !f.chains || chain === null || f.chains.includes(chain);
}
export function isFilter(v: unknown): v is LaunchFilter {
  return v === "fee0" || v === "burn" || v === "usdg" || v === "usdc" || v === "twig" || v === "gitlawb" || v === "today";
}

/** Trim, collapse whitespace, strip a leading $ (people type $SYM), lowercase. */
export function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ").replace(/^\$/, "").toLowerCase();
}
export function isAddressQuery(q: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(q.trim());
}

const DEAD = "0x000000000000000000000000000000000000dead";
type Matchable = { name: string; symbol: string; token: string; lp_fee: number; quote_key: string; block_time: string; recipients: { payout: string; bps: number }[] };

/** Client-side match over an already-loaded row. Name/symbol prefix or substring, or exact address. */
export function matchesQuery(l: Matchable, q: string): boolean {
  const n = normalizeQuery(q);
  if (!n) return true;
  if (isAddressQuery(n)) return l.token.toLowerCase() === n;
  return l.name.toLowerCase().includes(n) || l.symbol.toLowerCase().includes(n);
}

export function matchesFilter(l: Matchable, f: LaunchFilter | null, now = Date.now()): boolean {
  if (!f) return true;
  if (f === "fee0") return l.lp_fee === 0;
  if (f === "burn") return l.lp_fee > 0 && l.recipients.length === 1 && l.recipients[0].payout.toLowerCase() === DEAD;
  if (f === "usdg") return l.quote_key === "usdg";
  if (f === "usdc") return l.quote_key === "usdc";
  if (f === "twig") return l.quote_key === "twig";
  if (f === "gitlawb") return l.quote_key === "gitlawb";
  return now - new Date(l.block_time).getTime() < 86_400_000;
}

/** Rank search hits: symbol exact > symbol prefix > name prefix > substring. */
export function rankHit(l: Matchable, q: string): number {
  const n = normalizeQuery(q);
  const s = l.symbol.toLowerCase();
  const name = l.name.toLowerCase();
  if (s === n) return 0;
  if (s.startsWith(n)) return 1;
  if (name.startsWith(n)) return 2;
  return 3;
}

/**
 * Escape user input for a Postgres LIKE/ILIKE pattern (`%`, `_` and the escape
 * char itself). Without this, searching for `%` or `_` matches nearly every
 * row instead of the literal character.
 */
export function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** A search hit with the cross-chain ordering keys (block numbers are only comparable within one chain). */
export type RankedHit = Matchable & { chain_id: number; block_number: number };

/**
 * Full search ordering: relevance rank first, then cross-chain newest-first
 * (block time, chain id, block number — never raw block numbers across
 * chains, mirroring the list sorts). The SQL pre-limit must use the same key
 * or exact matches on a low-height chain never reach the ranker.
 */
export function compareSearchHit(a: RankedHit, b: RankedHit, q: string): number {
  return rankHit(a, q) - rankHit(b, q) || newestFirst(a, b);
}

/**
 * Ordering for quick jumps (the ⌘K search): relevance rank first, then the token held by more
 * wallets, then the same cross-chain newest-first. A token people actually hold outranks this
 * week's copies of its name, which newest-first would put on top. Holders is an indexed fact.
 */
export function compareSearchHitByHolders(a: RankedHit & { holders: number }, b: RankedHit & { holders: number }, q: string): number {
  return rankHit(a, q) - rankHit(b, q) || (b.holders || 0) - (a.holders || 0) || newestFirst(a, b);
}
