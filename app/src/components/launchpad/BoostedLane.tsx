"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import TokenAvatar from "./TokenAvatar";
import { TwigMark } from "./TwigBadge";
import { useLive } from "./LiveProvider";
import LiveNumber from "@/components/LiveNumber";
import type { BoostLane } from "@/lib/launchpad/boostServer";
import { BOOST_COPY, BOOST_LANE_SIZE, boostFuse, boostIgnitions, boostTimeLeft, boostWholeOf } from "@/lib/launchpad/boost";
import { capDisplay } from "@/lib/launchpad/market-cap";
import { explorerTx } from "@/lib/chainPublic";
import { setPendingToken } from "@/lib/launchpad/token-transition";

/** The rolling TWIG figure: "1.2M", "300K", like fmtBoostTwig (Intl rounds 999,999 up to "1M" by itself). */
const TWIG_FORMAT = { notation: "compact", maximumFractionDigits: 2 } as const;

/** Sparks that rise from the amount when a boost lands: offsets, delays and size. Decorative, a fixed set. */
const EMBERS: readonly { dx: number; dy: number; delay: number; size: number; ink?: boolean }[] = [
  { dx: -6, dy: -24, delay: 0, size: 4 },
  { dx: 3, dy: -32, delay: 90, size: 3, ink: true },
  { dx: 10, dy: -20, delay: 160, size: 3 },
  { dx: -1, dy: -28, delay: 240, size: 4, ink: true },
  { dx: 15, dy: -16, delay: 320, size: 3 },
];
/** An ignition is drawn for this long; older entries are dropped when the next one is recorded. */
const IGNITE_KEEP_MS = 10_000;

/**
 * The Boosted lane: tokens someone sent TWIG to 0x…dEaD for, most TWIG in the last 24 hours first (boost.ts). A paid,
 * labelled surface of its own, never mixed into the Live sort or the Trending board. Renders nothing while the BOOST
 * switch is off. It asks the shared live poll for the lane while it is on screen (wantBoost); a poll without it is no
 * news, so the cards stay as they are.
 *
 * Motion follows the board above it: nothing moves on its own. Each card carries a fuse (the share of its 24 hours
 * left, stepped with the card's clock), and a card lights up once when a fresh boost lands on it: a warm ring, the
 * amount rolling up, a few embers. Places change with a short slide.
 */
export default function BoostedLane({ initial, serverNow }: { initial: BoostLane; serverNow: number }) {
  const { subscribe, wantBoost } = useLive();
  const reduced = useReducedMotion();
  const [lane, setLane] = useState(initial);
  const [now, setNow] = useState(serverNow);
  // what each card held at the last snapshot: a token with more TWIG than this, freshly boosted, lights up
  const prev = useRef<Map<string, string> | null>(initial.enabled ? new Map(initial.items.map((i) => [i.token, i.twig])) : null);
  const [ignited, setIgnited] = useState<Record<string, number>>({});

  useEffect(() => wantBoost(), [wantBoost]);
  useEffect(() => {
    const unsubscribe = subscribe((snap) => {
      const next = snap.boost;
      if (!next) return;
      if (next.enabled) {
        const t = Date.now();
        const lit = boostIgnitions(prev.current, next.items, t);
        prev.current = new Map(next.items.map((i) => [i.token, i.twig]));
        if (lit.size > 0) {
          setIgnited((m) => {
            const kept = Object.fromEntries(Object.entries(m).filter(([, at]) => t - at < IGNITE_KEEP_MS));
            for (const token of lit) kept[token] = t;
            return kept;
          });
        }
      } else {
        prev.current = null;
      }
      setLane(next);
    });
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      unsubscribe();
      clearInterval(clock);
    };
  }, [subscribe]);

  if (!lane.enabled) return null;
  // a boost that ran out between polls leaves at once rather than showing "0m left"
  const items = lane.items.filter((b) => boostTimeLeft(b.last_at, now) !== null);
  return (
    <section id="boosted" aria-labelledby="boosted-heading" className="scroll-mt-24 rounded-2xl border border-line bg-card">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-3 sm:px-5">
        <h2 id="boosted-heading" className="flex items-center gap-2 text-sm font-semibold text-ink">
          <TwigMark size={16} className="rounded-[4px]" />
          {BOOST_COPY.laneTitle}
        </h2>
        <p className="min-w-0 text-pretty text-[11px] leading-relaxed text-muted">{BOOST_COPY.laneNote}</p>
      </div>
      {/* the whole rule, in place: no page to keep in step with the switch */}
      <details className="group border-b border-line px-4 sm:px-5">
        <summary className="flex min-h-9 w-fit cursor-pointer list-none items-center gap-1 text-[11px] text-muted hover:text-ink [&::-webkit-details-marker]:hidden">How boosts work<ChevronDown size={12} aria-hidden="true" className="group-open:rotate-180" /></summary>
        <div className="max-w-3xl space-y-1.5 pb-3 text-pretty text-[11px] leading-relaxed text-body">
          <p>{BOOST_COPY.what}</p>
          <p>{BOOST_COPY.how} {BOOST_COPY.tag}</p>
          <p>{BOOST_COPY.final}</p>
        </div>
      </details>
      {items.length === 0 ? (
        <p className="px-4 py-4 text-xs leading-relaxed text-muted sm:px-5">{BOOST_COPY.laneEmpty}</p>
      ) : (
        <ol aria-label="Boosted tokens" className="grid gap-px overflow-hidden rounded-b-2xl bg-line sm:grid-cols-2 lg:grid-cols-5">
          {items.map((b, i) => {
            const l = b.launch;
            const cap = capDisplay(l.fdv_quote, l.quote_usd, { key: l.quote_key, symbol: l.quote_symbol, decimals: l.quote_decimals }).compact;
            const left = boostTimeLeft(b.last_at, now);
            const fuse = boostFuse(b.last_at, now);
            const lit = ignited[l.token];
            // two columns from 640px: an odd last card takes the whole row instead of leaving a hole
            const lastOdd = i === items.length - 1 && items.length % 2 === 1;
            return (
              <motion.li
                key={l.token}
                layout={reduced ? false : "position"}
                transition={{ type: "spring", stiffness: 380, damping: 34 }}
                className={`relative flex min-w-0 flex-col gap-2 bg-card px-4 pb-3.5 pt-3 ${lastOdd ? "sm:col-span-2 lg:col-span-1" : ""}`}
              >
                {/* one warm ring per ignition: a new key replays it */}
                {lit ? <span key={`ring-${lit}`} aria-hidden="true" className="bb-boost-ring pointer-events-none absolute inset-0" /> : null}
                <Link
                  href={`/t/${l.chain}/${l.token}`}
                  onClick={() => setPendingToken({ chain: l.chain, token: l.token, name: l.name, symbol: l.symbol, image: l.image_url })}
                  className="group flex min-w-0 items-center gap-2.5"
                >
                  <TokenAvatar chain={l.chain} token={l.token} symbol={l.symbol} image={l.image_url} size={32} className="shrink-0 rounded-xl" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold text-ink group-hover:underline group-hover:underline-offset-2">{l.name}</span>
                    <span className="block truncate text-[11px] text-muted"><span className="font-mono text-body">{l.symbol}</span><span aria-hidden="true"> · </span><span className="sr-only">, market cap </span><span className="font-mono tnum">{cap}</span></span>
                  </span>
                </Link>
                <p className="flex min-w-0 items-baseline justify-between gap-2 text-[11px]">
                  <span className="relative truncate font-mono text-warm-ink tnum" title={`${b.boosts} ${b.boosts === 1 ? "boost" : "boosts"} from ${b.boosters} ${b.boosters === 1 ? "wallet" : "wallets"} in the last 24 hours`}>
                    <LiveNumber value={Number(boostWholeOf(BigInt(b.twig)))} format={TWIG_FORMAT} suffix=" TWIG" />
                    {lit ? (
                      <span key={`embers-${lit}`} aria-hidden="true" className="pointer-events-none absolute bottom-1 left-2">
                        {EMBERS.map((e, k) => (
                          <span
                            key={k}
                            className="bb-ember absolute rounded-full"
                            style={{ "--dx": `${e.dx}px`, "--dy": `${e.dy}px`, width: e.size, height: e.size, animationDelay: `${e.delay}ms`, background: e.ink ? "var(--color-warm-ink)" : "var(--color-warm)" } as CSSProperties}
                          />
                        ))}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-muted" suppressHydrationWarning>{left}</span>
                </p>
                <a href={explorerTx(l.chain, b.last_tx)} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-0.5 text-[10px] text-muted hover:text-ink">
                  Latest burn<ArrowUpRight size={10} aria-hidden="true" />
                </a>
                {/* the fuse: what is left of the 24 hours, burning down from the right; steps with the card's clock */}
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-warm/10">
                  <span className="relative block h-full bg-gradient-to-r from-warm/40 to-warm transition-[width] duration-1000 ease-linear motion-reduce:transition-none" style={{ width: `${(fuse * 100).toFixed(2)}%` }}>
                    {fuse > 0 ? <span className="absolute right-0 top-1/2 size-[5px] -translate-y-1/2 translate-x-1/2 rounded-full bg-warm shadow-[0_0_6px_var(--color-warm)]" /> : null}
                  </span>
                </span>
              </motion.li>
            );
          })}
          {/* five columns from 1024px: the free places read as open, never as a grey block */}
          {Array.from({ length: Math.max(0, BOOST_LANE_SIZE - items.length) }, (_, i) => (
            <li key={`open-${i}`} aria-hidden="true" className="hidden items-center justify-center bg-card px-4 py-3 text-[11px] text-faint lg:flex">Open spot</li>
          ))}
        </ol>
      )}
    </section>
  );
}
