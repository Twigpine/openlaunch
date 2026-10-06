"use client";

import { ArrowUpRight, ChevronDown } from "lucide-react";
import { useLive } from "./LiveProvider";
import LiveNumber, { COMPACT_USD } from "../LiveNumber";
import { GitlawbMark } from "./GitlawbBadge";
import { TwigMark } from "./TwigBadge";
import { fmtQuote, fmtUnitsExact, fmtUsd } from "@/lib/launchpad/math";
import { GITLAWB_DECIMALS, GITLAWB_SYMBOL } from "@/lib/launchpad/gitlawb";
import { TWIG_DECIMALS, TWIG_SYMBOL } from "@/lib/launchpad/twig";
import { BRAND_GITHUB } from "@/lib/brand";
import { CHAIN_KEYS, CHAIN_SHORT, chainList } from "@/lib/chainPublic";

/** Real network totals sit outside the illustrative launch, never inside it. */
export default function LaunchMechanism() {
  const { live } = useLive();
  const t = live.totals;
  // totals roll to their new value when a launch or trade lands (static on first paint and under reduced motion)
  const count = (value: number) => <LiveNumber value={value} />;
  // some quote has no price right now: the dollar sums undercount, so say "≈" instead of showing a confident smaller number
  const usdNote = t.usd_partial ? "Some launches are quoted in an asset with no USD price right now; dollar totals exclude them until it returns." : undefined;
  // `live` figures roll as they change (compact); the rest stay exact text. Both carry the same "≈" guard.
  const usd = (v: number, live = false) => (live ? <LiveNumber value={v} format={COMPACT_USD} prefix={t.usd_partial ? "≈" : undefined} /> : `${t.usd_partial ? "≈" : ""}${fmtUsd(v)}`);
  const gitlawbBurnedExact = `${fmtUnitsExact(t.gitlawb_burned, GITLAWB_DECIMALS)} ${GITLAWB_SYMBOL}`; // every digit of the raw amount, no float
  // TWIG burned: its own figure (the GITLAWB behind it stays in the TWIG contract), shown once there is any; null-safe for a poll from an older machine
  const twigBurned = t.twig_burned ?? "0";
  const twigBurnedExact = `${fmtUnitsExact(twigBurned, TWIG_DECIMALS)} ${TWIG_SYMBOL}`;
  return <div className="border-t border-line pt-4">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <span className="text-[11px] text-muted">Open by design. Free by construction.</span>
      <a href={`${BRAND_GITHUB}/tree/main/contracts/src`} target="_blank" rel="noreferrer" className="flex min-h-8 shrink-0 items-center gap-1 text-xs text-ink hover:underline underline-offset-4"><span className="font-mono tnum">$0</span> platform fee <ArrowUpRight size={12} aria-hidden /></a>
    </div>
    <dl className="mt-4 grid grid-cols-3 gap-3">
      <Metric label="Tokens launched" value={count(t.launches)} />
      <Metric label="All-time volume" value={usd(t.volume_usd, true)} title={usdNote ?? fmtUsd(t.volume_usd)} />
      <Metric label="Fees to recipients" value={usd(t.fees_to_creators_usd, true)} title={usdNote ?? fmtUsd(t.fees_to_creators_usd)} accent />
    </dl>
    <details className="group mt-3">
      <summary className="flex min-h-9 w-fit cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted hover:text-ink [&::-webkit-details-marker]:hidden">Across {chainList("&", CHAIN_SHORT)}<ChevronDown size={12} aria-hidden className="group-open:rotate-180" /><span className="sr-only">. Show the network breakdown</span></summary>
      <dl className="mt-2 grid grid-cols-2 gap-x-5 gap-y-3 border-t border-dashed border-line-strong py-4 text-xs">
        {CHAIN_KEYS.map((k) => <div key={k}><dt className="text-muted">{CHAIN_SHORT[k]} launches</dt><dd className="mt-1 font-mono text-ink tnum">{count(t.by_chain[k]?.launches ?? 0)}</dd></div>)}
        <div><dt className="text-muted">All-time trades</dt><dd className="mt-1 font-mono text-ink tnum">{count(t.trades)}</dd></div>
        <div><dt className="text-muted">Fees burned</dt><dd className="mt-1 font-mono text-warm-ink tnum" title={usdNote}>{usd(t.fees_burned_usd)}</dd></div>
        <div className="col-span-2"><dt className="flex items-center gap-1.5 text-muted" title="Sent to 0x…dEaD by GITLAWB-quoted launches on Base and Robinhood Chain"><GitlawbMark size={14} />GITLAWB burned</dt><dd className="mt-1 font-mono text-warm-ink tnum" title={gitlawbBurnedExact}>{fmtQuote(t.gitlawb_burned, GITLAWB_DECIMALS, GITLAWB_SYMBOL)}</dd></div>
        {BigInt(twigBurned) > 0n ? <div className="col-span-2"><dt className="flex items-center gap-1.5 text-muted" title="Sent to 0x…dEaD by TWIG-quoted launches on Base"><TwigMark size={14} />TWIG burned</dt><dd className="mt-1 font-mono text-warm-ink tnum" title={twigBurnedExact}>{fmtQuote(twigBurned, TWIG_DECIMALS, TWIG_SYMBOL)}</dd></div> : null}
      </dl>
      <p className="pb-2 text-[11px] leading-relaxed text-muted">Creators choose a 0%, 1% or 3% trading fee. It goes to their named recipients or is burned. The platform takes none.</p>
    </details>
  </div>;
}

function Metric({ label, value, title, accent = false }: { label: string; value: React.ReactNode; title?: string; accent?: boolean }) {
  return <div className="min-w-0"><dt className="min-h-7 sm:min-h-0 text-[10px] sm:text-[11px] text-muted">{label}</dt><dd title={title} className={`mt-1.5 break-words font-mono text-xl sm:text-2xl font-bold tracking-[-0.05em] tnum ${accent ? "text-up" : "text-ink"}`}>{value}</dd></div>;
}
