/** Pure shaping for the per-token share card (node --test loads this). */
import { CHAIN_LABELS, type ChainKey } from "../chainKeys.ts";

export type CardInput = { name: string; symbol: string; chain: ChainKey; fdv_usd: number | null; fdv_quote: number; quote_key: string; quote_symbol: string; change_from_launch: number; lp_fee: number; recipients: { payout: string; bps: number }[]; block_time: string };
export type Card = { title: string; symbol: string; chainLabel: string; mcap: string; change: string; up: boolean | null; fee: string; age: string; quote: { symbol: string; ticker: string; kind: "stock" | "gitlawb" | "museworld" } | null };

const DEAD = "0x000000000000000000000000000000000000dead";

function compact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(a >= 100 ? 0 : 2);
}

export function feeLabel(lpFee: number, recipients: { payout: string; bps: number }[]): string {
  if (lpFee === 0) return "0% fee";
  const pct = `${lpFee / 10_000}%`;
  if (recipients.length === 1 && recipients[0].payout.toLowerCase() === DEAD) return `${pct} fee, burned`;
  return `${pct} fee → ${recipients.length > 1 ? "beneficiaries" : "beneficiary"}`;
}

export function ageLabel(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(now)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s old`;
  if (s < 3600) return `${Math.floor(s / 60)}m old`;
  if (s < 86400) return `${Math.floor(s / 3600)}h old`;
  return `${Math.floor(s / 86400)}d old`;
}

export function shapeCard(l: CardInput, now: number): Card {
  const pct = l.change_from_launch * 100;
  const finitePct = Number.isFinite(pct);
  return {
    title: l.name.slice(0, 28),
    symbol: l.symbol.slice(0, 12),
    chainLabel: CHAIN_LABELS[l.chain],
    // an unknown cap is one dash, not "$—" or "— ETH"
    mcap: l.fdv_usd !== null ? (Number.isFinite(l.fdv_usd) ? `$${compact(l.fdv_usd)}` : "—") : Number.isFinite(l.fdv_quote) ? `${compact(l.fdv_quote)} ${l.quote_symbol}` : "—",
    change: finitePct ? `${pct >= 0 ? "+" : ""}${Math.abs(pct) >= 1000 ? compact(pct) : pct.toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%` : "—",
    up: finitePct ? pct >= 0 : null,
    fee: feeLabel(l.lp_fee, l.recipients),
    age: ageLabel(l.block_time, now),
    quote: quotePillOf(l.quote_key, l.quote_symbol),
  };
}

/** "priced in" pill: registry stocks get a ticker tile, GITLAWB the Gitlawb tile, MUSEWORLD the blue Museworld pill; ETH / USDG / unlisted get none. */
export function quotePillOf(quoteKey: string, quoteSymbol: string): Card["quote"] {
  if (quoteKey === "gitlawb") return { symbol: "GITLAWB", ticker: "GL", kind: "gitlawb" };
  if (quoteKey === "museworld") return { symbol: "MUSEWORLD", ticker: "MW", kind: "museworld" };
  const sym = quoteSymbol.trim();
  if (quoteKey !== "stock" || !sym || sym === "?") return null;
  return { symbol: sym.slice(0, 12), ticker: sym.replace(/c$/, "").toUpperCase().slice(0, 5), kind: "stock" };
}

/** Social previews show ~125 chars: clamp on a word boundary with an ellipsis; short text is untouched. */
export const SOCIAL_DESCRIPTION_MAX = 125;
export function clampSocial(text: string, max = SOCIAL_DESCRIPTION_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > max * 0.6 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.\-—]+$/, "")}…`;
}
