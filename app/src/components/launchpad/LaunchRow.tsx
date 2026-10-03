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
import WatchButton from "./WatchButton";
import styles from "./LaunchRow.module.css";

const columns = "launch-ledger";
const counts = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function TradeCounts({ buys, sells }: { buys: number; sells: number }) {
  const buyWord = buys === 1 ? "buy" : "buys";
  const sellWord = sells === 1 ? "sell" : "sells";
  const exact = `${buys} ${buyWord}, ${sells} ${sellWord}`;
  if (buys === 0 && sells === 0) {
    return <span className={styles.noTrades} title="0 buys, 0 sells"><span className="sr-only">0 buys, 0 sells. </span><span aria-hidden="true">No trades</span></span>;
  }
  return (
    <span className={styles.tradeCounts} title={exact}>
      <span className="sr-only">{exact}. </span>
      <span aria-hidden="true" className={styles.tradeValues}>
        <span><strong className={buys ? styles.buyValue : styles.zeroValue}>{counts.format(buys)}</strong> {buyWord}</span>
        <span className={styles.tradeDivider}>·</span>
        <span><strong className={sells ? styles.sellValue : styles.zeroValue}>{counts.format(sells)}</strong> {sellWord}</span>
      </span>
    </span>
  );
}

function ActivitySignal({ buys, sells, holders, volumeLabel }: { buys: number; sells: number; holders: number; volumeLabel?: string }) {
  return (
    <div className={styles.activity}>
      <TradeCounts buys={buys} sells={sells} />
      <div className={styles.activityMeta}>
        {volumeLabel ? <span className="lg:hidden"><span className="sr-only">Volume </span><span className="tnum">{volumeLabel}</span><span aria-hidden="true"> vol</span></span> : null}
        {volumeLabel ? <span className="lg:hidden" aria-hidden="true">·</span> : null}
        <span title={`${holders} ${holders === 1 ? "holder" : "holders"}`}><span className="sr-only">{`${holders} ${holders === 1 ? "holder" : "holders"}. `}</span><span aria-hidden="true"><span className="tnum">{counts.format(holders)}</span> {holders === 1 ? "holder" : "holders"}</span></span>
      </div>
    </div>
  );
}

export function LaunchListHeader({ window }: { window: VolumeWindow }) {
  return (
    <div aria-hidden="true" className={`${styles.listHeader} hidden sm:grid sticky top-14 z-20 ${columns} items-center gap-3 pl-12 pr-3`}>
      <span>Token</span>
      <span className="text-right">Market</span>
      <span className="hidden text-right lg:block">Volume · {window}</span>
      <span className="text-right">Order flow</span>
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
  const cap = capDisplay(l.fdv_quote, l.quote_usd, { key: l.quote_key, symbol: l.quote_symbol, decimals: l.quote_decimals });
  const capLabel = cap.main;
  const capDetail = cap.usd !== null ? `${fmtUsd(cap.usd)} · ${cap.detail}` : `${cap.main} · ${cap.detail}`;
  const feeLabel = mode === "free" ? "0% trading fee" : `${pipsToPct(l.lp_fee)} fee → ${mode === "burn" ? "burned" : mode === "split" ? "split" : "beneficiary"}`;
  const flash = hl ? `bb-row-${hl.kind}` : "";
  const age = <><span className="sr-only">Launched </span><time dateTime={l.block_time} title={new Date(l.block_time).toUTCString()} suppressHydrationWarning>{ago(l.block_time, now)}</time><span className="sr-only"> ago</span></>;
  const rowChip = chip?.tier === "quiet" ? l.launcher_collapsed ? { tier: chip.tier, text: `+${l.launcher_collapsed} more from this wallet` } : null : chip;
  const context = <><span className={styles.fee} data-mode={mode}>{feeLabel}</span>{rowChip ? <span className={styles.status} data-tier={rowChip.tier} title={rowChip.text} suppressHydrationWarning><span className={styles.statusDot} aria-hidden="true" />{rowChip.text}</span> : null}</>;

  return (
    <div className={styles.shell}>
      <div className={styles.watch}><WatchButton token={l} /></div>
      <Link href={`/t/${l.chain}/${l.token}`} className={`bb-market-row ${styles.row} group block pl-12 pr-3 outline-none ${flash}`} title={l.description || `${l.name} (${l.symbol})`}>
        <div className={`grid ${columns} grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-x-3 gap-y-1`}>
          <div className="flex min-w-0 items-center gap-2.5">
            {rank !== undefined ? <><span className="sr-only">Rank {rank}. </span><span aria-hidden="true" className={styles.rank}>{rank}</span></> : null}
            <TokenAvatar chain={l.chain} token={l.token} symbol={l.symbol} image={l.image_url} size={44} className={styles.avatar} />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className={styles.name}>{l.name}</span>
                <QuoteBrandBadge quoteKey={l.quote_key} />
                {l.quote_key === "other" ? <UnlistedPairBadge symbol={l.quote_symbol} className="shrink-0" /> : null}
                {hl?.kind === "new" ? <span className={styles.newLabel}>New</span> : null}
              </div>
              <div className={styles.identityMeta} title={`${l.symbol} · ${CHAIN_SHORT[l.chain]} · paired with ${l.quote_symbol}`}>
                <span className={styles.symbol}>{l.symbol}</span><span aria-hidden="true">·</span><span>{CHAIN_SHORT[l.chain]} / {l.quote_symbol}</span><span aria-hidden="true">·</span><span>{age}</span>
              </div>
            </div>
          </div>

          <div className={styles.context}>{context}</div>

          <div className={styles.marketCell}>
            <span className={styles.mobileMetricLabel}>Market cap</span>
            <div className={styles.capLine}>
              <span key={hl?.at ?? "rest"} className={`${styles.capValue} ${pop ? "bb-pop" : ""}`} title={capDetail}>{capLabel}</span>
              <span className="sr-only">Change since launch </span><ChangeChip v={l.change_from_launch} plain className={styles.change} />
            </div>
            <span className={styles.capDetail} title={capDetail}>{cap.detail}</span>
          </div>

          <div className={`${styles.volumeCell} hidden lg:block`} title={volumeDetail}><span className="sr-only">Volume {window} </span><span className={styles.volumeValue}>{volLabel}</span><span className={styles.metricHint}>{window === "all" ? "all time" : window}</span></div>
          <div className="hidden min-w-0 sm:block"><ActivitySignal buys={l.buys} sells={l.sells} holders={l.holders} volumeLabel={volLabel} /></div>

          <dl className={`${styles.mobileMetrics} col-span-2 sm:hidden`}>
            <div className="min-w-0"><dt>Volume · {window}</dt><dd title={volumeDetail}>{volLabel}</dd></div>
            <div className="min-w-0 text-right"><dt className="sr-only">Order flow</dt><dd><ActivitySignal buys={l.buys} sells={l.sells} holders={l.holders} /></dd></div>
          </dl>
        </div>
      </Link>
    </div>
  );
}
