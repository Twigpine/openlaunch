"use client";

import Link from "next/link";
import { useCallback, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import TokenAvatar from "./TokenAvatar";
import { feeModeOf } from "./FeeChip";
import type { LaunchRow as L, VolumeWindow } from "@/lib/launchpad/queries";
import { fmtCompact, fmtQuote, fmtUsd, pipsToPct } from "@/lib/launchpad/math";
import { CHAIN_SHORT } from "@/lib/chainPublic";
import { useAgo } from "@/i18n/useAgo";
import ChangeChip from "./ChangeChip";
import { QuoteBrandBadge } from "./QuoteBadge";
import UnlistedPairBadge from "./UnlistedPairBadge";
import { marketUsd } from "@/lib/launchpad/market-format";
import { capDisplay } from "@/lib/launchpad/market-cap";
import type { ChipParts, LiveTier } from "@/lib/launchpad/ranking";
import { MorphAvatar, MorphName } from "./TokenMorph";
import { ChainCorner } from "./ChainLogo";
import { setPendingToken } from "@/lib/launchpad/token-transition";

/** Token, market cap, since launch, volume, buys / sells, holders, age; the star sits in the right gutter (md:pr-13). */
const columns = "md:grid-cols-[minmax(0,1fr)_6.25rem_4.5rem_5rem_6rem_3.75rem_2.5rem]";
/** A count that never wraps its column: 3,231 below ten thousand, 22.5K above. */
const count = (n: number) => (n >= 10_000 ? fmtCompact(n, 1) : n.toLocaleString("en-US"));
const sr = (chunks: ReactNode) => <span className="sr-only">{chunks}</span>;

/** capDisplay in the reader's language: an unpriced cap's "no USD price" is words; every figure is data and stays as it is. */
export function localizedCap<C extends { main: string; detail: string; compact: string; usd: number | null }>(cap: C, noUsdPrice: string): C {
  return cap.usd !== null ? cap : { ...cap, detail: noUsdPrice, compact: `${cap.main} · ${noUsdPrice}` };
}

/** What a live chip says, as liveChipParts decides it: the tier, the wallet count, and whether a time and a folded-launch note apply. */
export type ChipFacts = Pick<ChipParts, "tier" | "count" | "when" | "more">;

/**
 * The live chip in the reader's language. ranking.ts decides the tier, the count and which notes apply; the words are
 * messages (market.chip): `text` is "3 wallets this hour" (`rich` marks the count up), `when` the last outside trade
 * ("12m ago") or the age ("4m"), `more` the launches folded into the row ("+4 from this wallet"). The window is
 * liveChipParts' own: this hour when outside wallets traded in it, else today.
 */
export function useLiveWords() {
  const t = useTranslations("market.chip");
  const { short, ago } = useAgo();
  return useCallback((l: Pick<L, "block_time" | "last_outside_trade_at" | "traders_1h_ex" | "launcher_collapsed">, chip: ChipFacts, now: number) => {
    const key = chip.tier === "live" ? (l.traders_1h_ex > 0 ? "hour" : "today") : chip.tier;
    const count = chip.count ?? 0;
    return {
      text: t.markup(key, { count, b: (chunks) => chunks }),
      rich: (b: (chunks: ReactNode) => ReactNode) => t.rich(key, { count, b }),
      when: chip.when === null ? null : chip.tier === "live" && l.last_outside_trade_at ? ago(l.last_outside_trade_at, now) : short(l.block_time, now),
      more: chip.more === null ? null : t("more", { count: l.launcher_collapsed }),
    };
  }, [t, short, ago]);
}
export type LiveWords = ReturnType<ReturnType<typeof useLiveWords>>;

export function LaunchListHeader({ window }: { window: VolumeWindow }) {
  const t = useTranslations("market");
  return (
    <div aria-hidden="true" className={`hidden md:grid ${columns} items-center gap-3 border-y border-line bg-card py-2.5 pl-4 pr-13 text-[11px] font-medium text-muted`}>
      <span>{t("row.token")}</span>
      <span className="text-right">{t("marketCap")}</span>
      <span className="text-right">{t("row.sinceLaunch")}</span>
      <span className="text-right">{t("row.volume", { window: window === "all" ? t("row.windowAll") : window })}</span>
      <span className="text-right">{t("row.buysSells")}</span>
      <span className="text-right">{t("row.holders")}</span>
      <span className="text-right">{t("row.age")}</span>
    </div>
  );
}

export type RowHighlight = { kind: "new" | "buy" | "sell"; at: number } | null;

/**
 * One market row, read like a trading board: the token in two lines (name and badges; ticker, chain and fee), a third
 * on the live sort for why it sits there, then one figure per column. Phones keep the token and its market cap on top
 * and fold the other columns into one line under it.
 */
export default function LaunchRow({ l, rank, window = "all", hl = null, now, pop = false, chip = null }: { l: L; ethUsd?: number | null; rank?: number; window?: VolumeWindow; hl?: RowHighlight; now: number; pop?: boolean; chip?: ChipParts | null }) {
  const t = useTranslations("market");
  const { short } = useAgo();
  const liveWords = useLiveWords();
  const mode = feeModeOf(l.lp_fee, l.recipients);
  const volRaw = window === "1h" ? l.volume_1h : window === "24h" ? l.volume_24h : l.volume_quote;
  const volUsd = window === "1h" ? l.volume_1h_usd : window === "24h" ? l.volume_24h_usd : l.volume_usd;
  const volLabel = volUsd !== null ? marketUsd(volUsd) : fmtQuote(volRaw, l.quote_decimals, l.quote_symbol);
  const volumeDetail = volUsd !== null ? fmtUsd(volUsd) : volLabel;
  const cap = localizedCap(capDisplay(l.fdv_quote, l.quote_usd, { key: l.quote_key, symbol: l.quote_symbol, decimals: l.quote_decimals }), t("noUsdPrice")); // dollars lead; the quote figure is the detail
  const capLabel = cap.main;
  const capDetail = cap.usd !== null ? `${fmtUsd(cap.usd)} · ${cap.detail}` : `${cap.main} · ${cap.detail}`;
  const pct = mode === "free" ? "0%" : pipsToPct(l.lp_fee);
  const feeLabel = t("row.fee", { pct });
  const feeTitle = mode === "free" ? t("row.feeNone") : t(mode === "burn" ? "row.feeBurned" : mode === "split" ? "row.feeSplit" : "row.feeRecipient", { pct });
  const trades = l.buys + l.sells;
  const windowLabel = window === "all" ? t("row.windowAll") : window;
  const flash = hl ? `bb-row-${hl.kind}` : "";
  const time = short(l.block_time, now);
  const age = (chunks: ReactNode) => <time dateTime={l.block_time} title={new Date(l.block_time).toUTCString()} suppressHydrationWarning>{chunks}</time>;
  const why = chip ? liveWords(l, chip, now) : null;
  const whyText = why ? [why.text, why.when, why.more].filter(Boolean).join(" · ") : "";

  return (
    <Link
      href={`/t/${l.chain}/${l.token}`}
      // leaves a note for the token page's loading header, so the mark and name morph on the very first frame
      onClick={() => setPendingToken({ chain: l.chain, token: l.token, name: l.name, symbol: l.symbol, image: l.image_url })}
      className={`bb-market-row group block border-b border-line bg-paper px-4 py-2.5 md:pr-13 transition-colors hover:bg-card focus-visible:relative focus-visible:z-10 motion-reduce:transition-none ${flash}`}
      title={l.description || `${l.name} (${l.symbol})`}
    >
      {/* the phone cap column is at most 9.25rem: a long quote figure ("2.61M 0xa69f…8792") truncates there instead of taking the row */}
      <div className={`grid ${columns} grid-cols-[minmax(0,1fr)_fit-content(9.25rem)] items-center gap-x-3 gap-y-1.5`}>
        <div className="flex min-w-0 items-center gap-3">
          {rank !== undefined ? <span className={`hidden shrink-0 place-items-center font-mono text-[11px] font-semibold tnum xl:grid ${rank <= 3 ? "size-5 rounded-md bg-ink text-inverse dark:bg-brand" : "w-5 text-faint"}`}>{rank}</span> : null}
          <span className="relative shrink-0">
            <MorphAvatar chain={l.chain} token={l.token}>
              <TokenAvatar chain={l.chain} token={l.token} symbol={l.symbol} image={l.image_url} size={38} className="shrink-0 rounded-xl" />
            </MorphAvatar>
            <ChainCorner chain={l.chain} />
          </span>
          <div className="min-w-0 flex-1">
            {/* below 1024px the badge drops under the name when the two do not fit, so a name is never squeezed to nothing
                (an unlisted-pair row on a phone, the narrow name column of the tablet table) */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 lg:flex-nowrap">
              <MorphName chain={l.chain} token={l.token}>
                <span className="truncate text-sm font-semibold text-ink">{l.name}</span>
              </MorphName>
              {/* phones show the badge's mark only, so the name keeps its room */}
              <QuoteBrandBadge quoteKey={l.quote_key} symbol={l.quote_symbol} logo={l.quote_logo} collapse />
              {l.quote_key === "other" ? <UnlistedPairBadge symbol={l.quote_symbol} className="shrink-0" /> : null}
              {hl?.kind === "new" ? <span className="shrink-0 rounded-md bg-brand-soft px-1.5 py-px text-[10px] font-semibold text-brand">{t("row.new")}</span> : null}
            </div>
            {/* ticker, chain and fee: one line that truncates as a whole */}
            <p className="mt-0.5 truncate text-[11px] text-muted" title={t("row.line", { symbol: l.symbol, chain: CHAIN_SHORT[l.chain], quote: l.quote_symbol, fee: feeTitle })}>
              <span className="font-mono text-body">{l.symbol}</span><span aria-hidden="true"> · </span>{CHAIN_SHORT[l.chain]}<span aria-hidden="true"> · </span><span className={mode === "burn" ? "text-warm-ink" : ""}><span className="sr-only">{feeTitle}</span><span aria-hidden="true">{feeLabel}</span></span>
            </p>
            {chip ? <Why tier={chip.tier} text={whyText} className="mt-0.5 hidden md:flex" /> : null}
          </div>
        </div>
        <div className="min-w-0 pr-9 text-right md:pr-0">
          <span key={hl?.at ?? "rest"} className={`block truncate font-mono text-sm font-bold text-ink tnum ${pop ? "bb-pop" : ""}`} title={capDetail}><span className="sr-only">{t("marketCap")} </span>{capLabel}</span>
          <span className="hidden truncate font-mono text-[10px] text-muted tnum md:block" title={capDetail}>{cap.detail}</span>
          <span className="mt-0.5 flex items-center justify-end gap-2 md:hidden"><span className="block truncate font-mono text-[10px] text-muted tnum" title={capDetail}>{cap.detail}</span><span className="sr-only">{t("changeSinceLaunch")} </span><ChangeChip v={l.change_from_launch} plain /></span>
        </div>
        <div className="hidden min-w-0 text-right md:block"><span className="sr-only">{t("changeSinceLaunch")} </span><ChangeChip v={l.change_from_launch} plain /></div>
        <div className="hidden min-w-0 text-right font-mono text-xs text-body tnum md:block" title={volumeDetail}><span className="sr-only">{t("row.volumeSpoken", { window: windowLabel })} </span><span className="block truncate">{volLabel}</span></div>
        <div className="hidden text-right font-mono text-xs tnum md:block" title={trades ? t("buysSells", { buys: l.buys.toLocaleString("en-US"), sells: l.sells.toLocaleString("en-US") }) : t("noTrades")}>
          <span className="whitespace-nowrap"><span className="sr-only">{t("row.buys")} </span><span className="text-up">{count(l.buys)}</span><span className="text-muted"> / </span><span className="sr-only">{t("row.sells")} </span><span className="text-down-ink">{count(l.sells)}</span></span>
          {/* the same split as a bar; a token with no trades keeps an empty track */}
          <div aria-hidden="true" className="ml-auto mt-1 flex h-[3px] w-16 gap-px">{trades ? <><span className="rounded-full bg-up" style={{ width: `${(l.buys / trades) * 100}%` }} /><span className="flex-1 rounded-full bg-down" /></> : <span className="flex-1 rounded-full bg-line" />}</div>
        </div>
        <div className="hidden text-right font-mono text-xs text-body tnum md:block"><span className="sr-only">{t("row.holders")} </span>{count(l.holders)}</div>
        <div className="hidden text-right font-mono text-[11px] text-muted tnum md:block">{t.rich("row.launched", { time, age, sr })}</div>
        {/* phones: why the row is live across the full width, then the other columns as one line */}
        {chip ? <Why tier={chip.tier} text={whyText} className="col-span-2 flex md:hidden" /> : null}
        <p className="col-span-2 flex min-w-0 items-center gap-x-3 truncate text-[11px] text-muted md:hidden">
          <span className="truncate"><span className="text-faint">{t("row.vol")} </span><span className="font-mono text-body tnum" title={volumeDetail}>{volLabel}</span></span>
          <span className="shrink-0 font-mono tnum"><span className="text-up">{count(l.buys)}</span><span> / </span><span className="text-down-ink">{count(l.sells)}</span></span>
          <span className="shrink-0">{t.rich("row.holderCount", { count: count(l.holders), num: (chunks) => <span className="font-mono text-body tnum">{chunks}</span> })}</span>
          <span className="ml-auto shrink-0 font-mono tnum">{age(time)}</span>
        </p>
      </div>
    </Link>
  );
}

/** Why the row sits where it sits on the live sort: "55 wallets today · 10h ago", "just launched · 4m", "no buyers yet". */
function Why({ tier, text, className }: { tier: LiveTier; text: string; className: string }) {
  return (
    <p className={`min-w-0 items-center gap-1.5 text-[11px] font-medium ${tier === "live" ? "text-up" : tier === "new" ? "text-brand" : "text-muted"} ${className}`}>
      {tier === "live" ? <span aria-hidden="true" className="bb-beacon relative inline-block size-1.5 shrink-0 rounded-full bg-up" /> : null}
      <span className="truncate" suppressHydrationWarning>{text}</span>
    </p>
  );
}
