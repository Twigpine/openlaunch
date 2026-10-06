"use client";

import Link from "next/link";
import TokenAvatar from "./TokenAvatar";
import { feeModeOf } from "./FeeChip";
import type { LaunchRow as L, VolumeWindow } from "@/lib/launchpad/queries";
import { fmtCompact, fmtQuote, fmtUsd, pipsToPct } from "@/lib/launchpad/math";
import { CHAIN_SHORT } from "@/lib/chainPublic";
import { ago } from "@/lib/launchpad/time";
import ChangeChip from "./ChangeChip";
import { QuoteBrandBadge } from "./MuseworldBadge";
import UnlistedPairBadge from "./UnlistedPairBadge";
import { marketUsd } from "@/lib/launchpad/market-format";
import { capDisplay } from "@/lib/launchpad/market-cap";
import type { LiveTier } from "@/lib/launchpad/ranking";
import { MorphAvatar, MorphName } from "./TokenMorph";
import { ChainCorner } from "./ChainLogo";
import { setPendingToken } from "@/lib/launchpad/token-transition";

/** Token, market cap, since launch, volume, buys / sells, holders, age; the star sits in the right gutter (md:pr-13). */
const columns = "md:grid-cols-[minmax(0,1fr)_6.25rem_4.5rem_5rem_6rem_3.75rem_2.5rem]";
/** A count that never wraps its column: 3,231 below ten thousand, 22.5K above. */
const count = (n: number) => (n >= 10_000 ? fmtCompact(n, 1) : n.toLocaleString("en-US"));

export function LaunchListHeader({ window }: { window: VolumeWindow }) {
  return (
    <div aria-hidden="true" className={`hidden md:grid ${columns} items-center gap-3 border-y border-line bg-card py-2.5 pl-4 pr-13 text-[11px] font-medium text-muted`}>
      <span>Token</span>
      <span className="text-right">Market cap</span>
      <span className="text-right">Since launch</span>
      <span className="text-right">Volume · {window}</span>
      <span className="text-right">Buys / sells</span>
      <span className="text-right">Holders</span>
      <span className="text-right">Age</span>
    </div>
  );
}

export type RowHighlight = { kind: "new" | "buy" | "sell"; at: number } | null;

export type RowChip = { tier: LiveTier; text: string } | null;

/**
 * One market row, read like a trading board: the token in two lines (name and badges; ticker, chain and fee), a third
 * on the live sort for why it sits there, then one figure per column. Phones keep the token and its market cap on top
 * and fold the other columns into one line under it.
 */
export default function LaunchRow({ l, rank, window = "all", hl = null, now, pop = false, chip = null }: { l: L; ethUsd?: number | null; rank?: number; window?: VolumeWindow; hl?: RowHighlight; now: number; pop?: boolean; chip?: RowChip }) {
  const mode = feeModeOf(l.lp_fee, l.recipients);
  const volRaw = window === "1h" ? l.volume_1h : window === "24h" ? l.volume_24h : l.volume_quote;
  const volUsd = window === "1h" ? l.volume_1h_usd : window === "24h" ? l.volume_24h_usd : l.volume_usd;
  const volLabel = volUsd !== null ? marketUsd(volUsd) : fmtQuote(volRaw, l.quote_decimals, l.quote_symbol);
  const volumeDetail = volUsd !== null ? fmtUsd(volUsd) : volLabel;
  const cap = capDisplay(l.fdv_quote, l.quote_usd, { key: l.quote_key, symbol: l.quote_symbol, decimals: l.quote_decimals }); // dollars lead; the quote figure is the detail
  const capLabel = cap.main;
  const capDetail = cap.usd !== null ? `${fmtUsd(cap.usd)} · ${cap.detail}` : `${cap.main} · ${cap.detail}`;
  const feeLabel = mode === "free" ? "0% fee" : `${pipsToPct(l.lp_fee)} fee`;
  const feeTitle = mode === "free" ? "No trading fee" : `${pipsToPct(l.lp_fee)} trading fee, ${mode === "burn" ? "burned" : mode === "split" ? "split between recipients" : "to the recipient"}`;
  const trades = l.buys + l.sells;
  const flash = hl ? `bb-row-${hl.kind}` : "";
  const age = <time dateTime={l.block_time} title={new Date(l.block_time).toUTCString()} suppressHydrationWarning>{ago(l.block_time, now)}</time>;

  return (
    <Link
      href={`/t/${l.chain}/${l.token}`}
      // leaves a note for the token page's loading header, so the mark and name morph on the very first frame
      onClick={() => setPendingToken({ chain: l.chain, token: l.token, name: l.name, symbol: l.symbol, image: l.image_url })}
      className={`bb-market-row group block border-b border-line bg-paper px-4 py-2.5 md:pr-13 transition-colors hover:bg-card focus-visible:relative focus-visible:z-10 motion-reduce:transition-none ${flash}`}
      title={l.description || `${l.name} (${l.symbol})`}
    >
      <div className={`grid ${columns} grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5`}>
        <div className="flex min-w-0 items-center gap-3">
          {rank !== undefined ? <span className={`hidden shrink-0 place-items-center font-mono text-[11px] font-semibold tnum xl:grid ${rank <= 3 ? "size-5 rounded-md bg-ink text-inverse dark:bg-brand" : "w-5 text-faint"}`}>{rank}</span> : null}
          <span className="relative shrink-0">
            <MorphAvatar chain={l.chain} token={l.token}>
              <TokenAvatar chain={l.chain} token={l.token} symbol={l.symbol} image={l.image_url} size={38} className="shrink-0 rounded-xl" />
            </MorphAvatar>
            <ChainCorner chain={l.chain} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <MorphName chain={l.chain} token={l.token}>
                <span className="truncate text-sm font-semibold text-ink">{l.name}</span>
              </MorphName>
              {/* phones show the badge's mark only, so the name keeps its room */}
              <QuoteBrandBadge quoteKey={l.quote_key} collapse />
              {l.quote_key === "other" ? <UnlistedPairBadge symbol={l.quote_symbol} className="shrink-0" /> : null}
              {hl?.kind === "new" ? <span className="shrink-0 rounded-md bg-brand-soft px-1.5 py-px text-[10px] font-semibold text-brand">New</span> : null}
            </div>
            {/* ticker, chain and fee: one line that truncates as a whole */}
            <p className="mt-0.5 truncate text-[11px] text-muted" title={`${l.symbol} · ${CHAIN_SHORT[l.chain]} · paired with ${l.quote_symbol} · ${feeTitle}`}>
              <span className="font-mono text-body">{l.symbol}</span><span aria-hidden="true"> · </span>{CHAIN_SHORT[l.chain]}<span aria-hidden="true"> · </span><span className={mode === "burn" ? "text-warm-ink" : ""}><span className="sr-only">{feeTitle}</span><span aria-hidden="true">{feeLabel}</span></span>
            </p>
            {chip ? <Why chip={chip} className="mt-0.5 hidden md:flex" /> : null}
          </div>
        </div>
        <div className="min-w-0 pr-9 text-right md:pr-0">
          <span key={hl?.at ?? "rest"} className={`block truncate font-mono text-sm font-bold text-ink tnum ${pop ? "bb-pop" : ""}`} title={capDetail}><span className="sr-only">Market cap </span>{capLabel}</span>
          <span className="hidden truncate font-mono text-[10px] text-muted tnum md:block" title={capDetail}>{cap.detail}</span>
          <span className="mt-0.5 flex items-center justify-end gap-2 md:hidden"><span className="block truncate font-mono text-[10px] text-muted tnum" title={capDetail}>{cap.detail}</span><span className="sr-only">Change since launch </span><ChangeChip v={l.change_from_launch} plain /></span>
        </div>
        <div className="hidden min-w-0 text-right md:block"><span className="sr-only">Change since launch </span><ChangeChip v={l.change_from_launch} plain /></div>
        <div className="hidden min-w-0 text-right font-mono text-xs text-body tnum md:block" title={volumeDetail}><span className="sr-only">Volume {window} </span><span className="block truncate">{volLabel}</span></div>
        <div className="hidden text-right font-mono text-xs tnum md:block" title={trades ? `${l.buys.toLocaleString("en-US")} buys, ${l.sells.toLocaleString("en-US")} sells` : "No trades yet"}>
          <span className="whitespace-nowrap"><span className="sr-only">Buys </span><span className="text-up">{count(l.buys)}</span><span className="text-muted"> / </span><span className="sr-only">Sells </span><span className="text-down-ink">{count(l.sells)}</span></span>
          {/* the same split as a bar; a token with no trades keeps an empty track */}
          <div aria-hidden="true" className="ml-auto mt-1 flex h-[3px] w-16 gap-px">{trades ? <><span className="rounded-full bg-up" style={{ width: `${(l.buys / trades) * 100}%` }} /><span className="flex-1 rounded-full bg-down" /></> : <span className="flex-1 rounded-full bg-line" />}</div>
        </div>
        <div className="hidden text-right font-mono text-xs text-body tnum md:block"><span className="sr-only">Holders </span>{count(l.holders)}</div>
        <div className="hidden text-right font-mono text-[11px] text-muted tnum md:block"><span className="sr-only">Launched </span>{age}<span className="sr-only"> ago</span></div>
        {/* phones: why the row is live across the full width, then the other columns as one line */}
        {chip ? <Why chip={chip} className="col-span-2 flex md:hidden" /> : null}
        <p className="col-span-2 flex min-w-0 items-center gap-x-3 truncate text-[11px] text-muted md:hidden">
          <span className="truncate"><span className="text-faint">Vol </span><span className="font-mono text-body tnum" title={volumeDetail}>{volLabel}</span></span>
          <span className="shrink-0 font-mono tnum"><span className="text-up">{count(l.buys)}</span><span> / </span><span className="text-down-ink">{count(l.sells)}</span></span>
          <span className="shrink-0"><span className="font-mono text-body tnum">{count(l.holders)}</span> holders</span>
          <span className="ml-auto shrink-0 font-mono tnum">{age}</span>
        </p>
      </div>
    </Link>
  );
}

/** Why the row sits where it sits on the live sort: "55 wallets today · 10h ago", "just launched · 4m", "no buyers yet". */
function Why({ chip, className }: { chip: NonNullable<RowChip>; className: string }) {
  return (
    <p className={`min-w-0 items-center gap-1.5 text-[11px] font-medium ${chip.tier === "live" ? "text-up" : chip.tier === "new" ? "text-brand" : "text-muted"} ${className}`}>
      {chip.tier === "live" ? <span aria-hidden="true" className="bb-beacon relative inline-block size-1.5 shrink-0 rounded-full bg-up" /> : null}
      <span className="truncate" suppressHydrationWarning>{chip.text}</span>
    </p>
  );
}
