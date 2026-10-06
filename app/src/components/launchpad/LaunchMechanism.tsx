"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { useLive } from "./LiveProvider";
import LiveNumber, { COMPACT_USD } from "../LiveNumber";
import { GitlawbMark } from "./GitlawbBadge";
import { TwigMark } from "./TwigBadge";
import { fmtQuote, fmtUnitsExact, fmtUsd } from "@/lib/launchpad/math";
import { GITLAWB_DECIMALS, GITLAWB_SYMBOL } from "@/lib/launchpad/gitlawb";
import { TWIG_DECIMALS, TWIG_SYMBOL } from "@/lib/launchpad/twig";
import { BRAND_GITHUB } from "@/lib/brand";
import { CHAIN_KEYS, CHAIN_LABELS, chainList } from "@/lib/chainPublic";
import styles from "./LaunchMechanism.module.css";

/** Characters in a grouped count such as "114,839". Counted by hand so the server and the browser always agree. */
const countChars = (n: number) => { const digits = String(Math.trunc(Math.abs(n))).length; return digits + Math.floor((digits - 1) / 3); };
/** The longest a compact dollar figure gets ("$999.9M"). A constant: Intl prints "$1K" or "$1.0K" depending on the runtime. */
const USD_CHARS = 7;

/**
 * The network's real totals as one instrument strip: Trades, the page's one big live figure, then launches,
 * volume and fees, ending on the reading that never moves ($0 to us). The per-chain breakdown sits behind a toggle.
 */
export default function LaunchMechanism() {
  const { live, subscribe } = useLive();
  // The dollar sums are raw quote totals times the price right now, so they drift between polls with no trade, and two
  // servers with different cached prices make them alternate. Latch: what is shown is replaced only when something
  // happened on-chain (a trade, a launch, a burn: raw amounts with no price in them) or a quote lost or regained its
  // price. The counts still roll on every trade. A poll from an older machine carries no TWIG figure and is no news.
  const [t, setT] = useState(live.totals);
  useEffect(() => subscribe(({ totals }) => {
    setT((shown) => (totals.trades !== shown.trades || totals.launches !== shown.launches || totals.usd_partial !== shown.usd_partial || totals.gitlawb_burned !== shown.gitlawb_burned || (totals.twig_burned ?? shown.twig_burned) !== shown.twig_burned ? totals : shown));
  }), [subscribe]);
  // totals roll to their new value when a launch or trade lands (static on first paint and under reduced motion)
  const count = (value: number) => <LiveNumber value={value} />;
  // some quote has no price right now: the dollar sums undercount, so say "≈" instead of showing a confident smaller number
  const usdNote = t.usd_partial ? "Some launches are quoted in an asset with no USD price right now; dollar totals exclude them until it returns." : undefined;
  // `live` figures roll as they change (compact); the rest stay exact text. Both carry the same "≈" guard.
  const usd = (v: number, live = false) => (live ? <LiveNumber value={v} format={COMPACT_USD} prefix={t.usd_partial ? "≈" : undefined} /> : `${t.usd_partial ? "≈" : ""}${fmtUsd(v)}`);
  // the compact figure rounds, so its tooltip carries the exact sum and says what kind of number it is
  const usdTitle = (v: number, what: string) => usdNote ?? `${fmtUsd(v)} · ${what} valued at current rates`;
  const usdChars = USD_CHARS + (t.usd_partial ? 1 : 0);
  const gitlawbBurnedExact = `${fmtUnitsExact(t.gitlawb_burned, GITLAWB_DECIMALS)} ${GITLAWB_SYMBOL}`; // every digit of the raw amount, no float
  // TWIG burned: its own figure (the GITLAWB behind it stays in the TWIG contract), shown once there is any; null-safe for a poll from an older machine
  const twigBurned = t.twig_burned ?? "0";
  const twigBurnedExact = `${fmtUnitsExact(twigBurned, TWIG_DECIMALS)} ${TWIG_SYMBOL}`;
  return <section aria-label="Network totals" className={styles.panel}>
    <dl className={styles.readings}>
      <Reading lead label="Trades" note="buys and sells, all on-chain" chars={countChars(t.trades)}>{count(t.trades)}</Reading>
      <Reading label="Tokens launched" note={`on ${chainList("&", CHAIN_LABELS)}`} chars={countChars(t.launches)}>{count(t.launches)}</Reading>
      <Reading label="All-time volume" note="through Uniswap v4 pools" title={usdTitle(t.volume_usd, "quote volume")} chars={usdChars}>{usd(t.volume_usd, true)}</Reading>
      <Reading label="Fees to recipients" note="to the wallets creators chose" title={usdTitle(t.fees_to_creators_usd, "quote-asset fees")} tone="up" chars={usdChars}>{usd(t.fees_to_creators_usd, true)}</Reading>
      {/* plain text, not a roller: this reading never changes, and the strut in the stylesheet already puts it on its neighbours' baseline */}
      <Reading label="Platform fee" note="to us, on every chain" tone="brand" chars={2}>$0</Reading>
    </dl>
    <details className={`group ${styles.breakdown}`}>
      <summary className="-mx-2 flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 px-2 text-xs text-muted hover:text-ink lg:min-h-9 [&::-webkit-details-marker]:hidden">The numbers across {chainList("&", CHAIN_LABELS)}<ChevronDown size={13} aria-hidden="true" className="group-open:rotate-180" /></summary>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-t border-dashed border-line-strong py-4 text-xs sm:grid-cols-4 lg:grid-cols-[repeat(7,auto)] lg:justify-between">
        {CHAIN_KEYS.map((k) => <div key={k}><dt className="text-muted">{CHAIN_LABELS[k]} launches</dt><dd className="mt-1 font-mono text-ink tnum">{count(t.by_chain[k]?.launches ?? 0)}</dd></div>)}
        <div><dt className="text-muted">All-time trades</dt><dd className="mt-1 font-mono text-ink tnum">{count(t.trades)}</dd></div>
        <div><dt className="text-muted">All-time volume</dt><dd className="mt-1 font-mono text-ink tnum" title={usdNote}>{usd(t.volume_usd)}</dd></div>
        <div><dt className="text-muted">Fees to recipients</dt><dd className="mt-1 font-mono text-up tnum" title={usdNote}>{usd(t.fees_to_creators_usd)}</dd></div>
        <div><dt className="text-muted">Fees burned</dt><dd className="mt-1 font-mono text-warm-ink tnum" title={usdNote}>{usd(t.fees_burned_usd)}</dd></div>
        <div className="col-span-2"><dt className="flex items-center gap-1.5 text-muted" title="Sent to 0x…dEaD by GITLAWB-quoted launches on Base and Robinhood Chain"><GitlawbMark size={14} />GITLAWB burned</dt><dd className="mt-1 font-mono text-warm-ink tnum" title={gitlawbBurnedExact}>{fmtQuote(t.gitlawb_burned, GITLAWB_DECIMALS, GITLAWB_SYMBOL)}</dd></div>
        {BigInt(twigBurned) > 0n ? <div className="col-span-2"><dt className="flex items-center gap-1.5 text-muted" title="Sent to 0x…dEaD by TWIG-quoted launches on Base"><TwigMark size={14} />TWIG burned</dt><dd className="mt-1 font-mono text-warm-ink tnum" title={twigBurnedExact}>{fmtQuote(twigBurned, TWIG_DECIMALS, TWIG_SYMBOL)}</dd></div> : null}
      </dl>
      {/* the "≈" explained in the open: a title alone cannot be reached by touch or keyboard */}
      {usdNote ? <p className="mb-2 max-w-2xl text-pretty text-[11px] leading-relaxed text-body">≈ {usdNote}</p> : null}
      <p className="max-w-2xl text-pretty text-[11px] leading-relaxed text-muted">Creators choose a 0%, 1% or 3% trading fee. It goes to their named recipients or is burned. The platform takes none: no fee address in the factory, no platform cut in the locker.</p>
      <a href={`${BRAND_GITHUB}/tree/main/contracts/src`} target="_blank" rel="noreferrer" className="mt-1 mb-2 inline-flex min-h-9 items-center gap-1 text-xs font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">Read the contracts<ArrowUpRight size={12} aria-hidden="true" /></a>
    </details>
  </section>;
}

/** One reading. `chars` is the figure's length: the stylesheet sizes it from that and the room it has, so it never clips. */
function Reading({ label, note: text, chars, title, tone, lead = false, children }: { label: string; note: string; chars: number; title?: string; tone?: "up" | "brand"; lead?: boolean; children: React.ReactNode }) {
  // a chain's two-word name stays on one line: a note that wraps after bare "Robinhood" reads like the broker
  const note = text.replaceAll(" Chain", "\u00a0Chain");
  return <div className={lead ? `${styles.reading} ${styles.lead}` : styles.reading}>
    <dt className={styles.label}>{label}</dt>
    <dd title={title} className={`${styles.figure} ${tone === "up" ? "text-up" : tone === "brand" ? "text-brand" : "text-ink"}`}><span className={styles.value} style={{ "--chars": chars } as CSSProperties}>{children}</span></dd>
    <dd className={styles.note}>{note}</dd>
  </div>;
}
