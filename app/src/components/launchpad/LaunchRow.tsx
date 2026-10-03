"use client";

import Link from "next/link";
import TokenAvatar from "./TokenAvatar";
import { feeModeOf } from "./FeeChip";
import type { LaunchRow as L, VolumeWindow } from "@/lib/launchpad/queries";
import { fmtQuote, fmtUsd, pipsToPct } from "@/lib/launchpad/math";
import { CHAIN_SHORT } from "@/lib/chainPublic";
import { ago } from "@/lib/launchpad/time";
import ChangeChip from "./ChangeChip";
import { QuoteBrandBadge } from "./MuseworldBadge";
import UnlistedPairBadge from "./UnlistedPairBadge";
import { marketUsd } from "@/lib/launchpad/market-format";
import { capDisplay } from "@/lib/launchpad/market-cap";
import type { LiveTier } from "@/lib/launchpad/ranking";

const columns = "md:grid-cols-[minmax(0,1fr)_6.5rem_5.5rem_6rem_5rem_2.5rem]";

export function LaunchListHeader({ window }: { window: VolumeWindow }) {
  return (
    <div aria-hidden="true" className={`hidden md:grid ${columns} items-center gap-3 border-y border-line bg-card px-4 py-3 text-[11px] font-medium text-muted`}>
      <span>Token / paired with</span>
      <span className="text-right">Market cap</span>
      <span className="text-right">Since launch</span>
      <span className="text-right">Volume · {window}</span>
      <span className="text-right">Buys / sells</span>
      <span className="text-right">Age</span>
    </div>
  );
}

export type RowHighlight = { kind: "new" | "buy" | "sell"; at: number } | null;

export type RowChip = { tier: LiveTier; text: string } | null;

export default function LaunchRow({ l, rank, window = "all", hl = null, now, pop = false, chip = null }: { l: L; ethUsd?: number | null; rank?: number; window?: VolumeWindow; hl?: RowHighlight; now: number; pop?: boolean; chip?: RowChip }) {
  const mode = feeModeOf(l.lp_fee, l.recipients);
  const volRaw = window === "1h" ? l.volume_1h : window === "24h" ? l.volume_24h : l.volume_quote;
  const volUsd = window === "1h" ? l.volume_1h_usd : window === "24h" ? l.volume_24h_usd : l.volume_usd;
  const volLabel = volUsd !== null ? marketUsd(volUsd) : fmtQuote(volRaw, l.quote_decimals, l.quote_symbol);
  const volumeDetail = volUsd !== null ? fmtUsd(volUsd) : volLabel;
  const cap = capDisplay(l.fdv_quote, l.quote_usd, { key: l.quote_key, symbol: l.quote_symbol, decimals: l.quote_decimals }); // dollars lead; the quote figure is the detail
  const capLabel = cap.main;
  const capDetail = cap.usd !== null ? `${fmtUsd(cap.usd)} · ${cap.detail}` : `${cap.main} · ${cap.detail}`;
  const feeLabel = mode === "free" ? "0% trading fee" : `${pipsToPct(l.lp_fee)} fee → ${mode === "burn" ? "burned" : mode === "split" ? "split" : "beneficiary"}`;
  const flash = hl ? `bb-row-${hl.kind}` : "";
  const age = <time dateTime={l.block_time} title={new Date(l.block_time).toUTCString()} suppressHydrationWarning>{ago(l.block_time, now)}</time>;

  return (
    <Link href={`/t/${l.chain}/${l.token}`} className={`bb-market-row group block border-b border-line bg-paper px-4 py-3.5 transition-colors hover:bg-card focus-visible:relative focus-visible:z-10 motion-reduce:transition-none ${flash}`} title={l.description || `${l.name} (${l.symbol})`}>
      <div className={`grid ${columns} grid-cols-[minmax(0,1fr)_7rem] items-center gap-x-3 gap-y-3`}>
        <div className="flex min-w-0 items-center gap-2.5">
          {rank !== undefined ? <span className="hidden w-4 shrink-0 text-right font-mono text-[11px] text-muted tnum xl:block">{rank}</span> : null}
          <TokenAvatar chain={l.chain} token={l.token} symbol={l.symbol} image={l.image_url} size={36} className="shrink-0 rounded-lg" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold text-ink">{l.name}</span>
              <QuoteBrandBadge quoteKey={l.quote_key} />
              {l.quote_key === "other" ? <UnlistedPairBadge symbol={l.quote_symbol} className="shrink-0" /> : null}
              {hl?.kind === "new" ? <span className="shrink-0 text-[10px] font-medium text-brand">New</span> : null}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted" title={`${l.symbol} · ${CHAIN_SHORT[l.chain]} · paired with ${l.quote_symbol}`}>
              <span className="font-mono text-body">{l.symbol}</span><span aria-hidden="true"> · </span>{CHAIN_SHORT[l.chain]}<span aria-hidden="true"> · </span>{l.quote_symbol}
            </div>
            <div className={`mt-0.5 truncate text-[11px] ${mode === "burn" ? "text-warm-ink" : "text-muted"}`}>{feeLabel}</div>
            {chip ? <div className={`mt-0.5 truncate text-[11px] ${chip.tier === "live" ? "text-up" : chip.tier === "new" ? "text-brand" : "text-muted"}`} suppressHydrationWarning>{chip.text}</div> : null}
          </div>
        </div>
        <div className="min-w-0 text-right">
          <span className="mb-0.5 block text-[10px] text-muted md:sr-only">Market cap</span>
          <span key={hl?.at ?? "rest"} className={`block truncate font-mono text-sm font-bold text-ink tnum ${pop ? "bb-pop" : ""}`} title={capDetail}>{capLabel}</span>
          <span className="hidden truncate font-mono text-[10px] text-muted tnum md:block" title={capDetail}>{cap.detail}</span>
          <span className="mt-0.5 block md:hidden"><span className="block truncate font-mono text-[10px] text-muted tnum" title={capDetail}>{cap.detail}</span><span className="sr-only">Change since launch </span><ChangeChip v={l.change_from_launch} plain /></span>
        </div>
        <div className="hidden min-w-0 text-right md:block"><span className="sr-only">Change since launch </span><ChangeChip v={l.change_from_launch} plain /></div>
        <div className="hidden min-w-0 text-right font-mono text-xs text-body tnum md:block" title={volumeDetail}><span className="sr-only">Volume {window} </span><span className="block truncate">{volLabel}</span></div>
        <div className="hidden text-right font-mono text-xs tnum md:block">
          <span className="sr-only">Buys </span><span className="text-up">{l.buys}</span><span className="text-muted"> / </span><span className="sr-only">Sells </span><span className="text-down-ink">{l.sells}</span>
          <div className="mt-0.5 text-[10px] text-muted">{l.holders} holders</div>
        </div>
        <div className="hidden text-right font-mono text-[11px] text-muted tnum md:block"><span className="sr-only">Launched </span>{age}<span className="sr-only"> ago</span></div>
        <dl className="col-span-2 grid grid-cols-[1.3fr_1fr_1fr_auto] gap-3 border-t border-line pt-2.5 md:hidden">
          <div className="min-w-0"><dt className="text-[10px] text-muted">Volume · {window}</dt><dd className="mt-1 truncate font-mono text-[11px] text-body tnum" title={volumeDetail}>{volLabel}</dd></div>
          <div><dt className="text-[10px] text-muted">Buys / sells</dt><dd className="mt-1 font-mono text-[11px] tnum"><span className="text-up">{l.buys}</span><span className="text-muted"> / </span><span className="text-down-ink">{l.sells}</span></dd></div>
          <div><dt className="text-[10px] text-muted">Holders</dt><dd className="mt-1 font-mono text-[11px] text-body tnum">{l.holders}</dd></div>
          <div className="text-right"><dt className="text-[10px] text-muted">Age</dt><dd className="mt-1 font-mono text-[11px] text-body tnum">{age}</dd></div>
        </dl>
      </div>
    </Link>
  );
}
