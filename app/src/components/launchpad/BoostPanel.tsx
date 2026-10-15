"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { btn } from "@/components/ui";
import { useLive } from "./LiveProvider";
import { TwigMark } from "./TwigBadge";
import type { TokenBoost } from "@/lib/launchpad/boostServer";
import { BOOST_CHAIN, BOOST_COPY, boostTimeLeft, fmtBoostTwig } from "@/lib/launchpad/boost";
import { explorerTx } from "@/lib/chainPublic";
import type { PendingBoost } from "./BoostDialog";

// the dialog (wallet reads, the send flow) loads on first use, not with the page
const BoostDialog = dynamic(() => import("./BoostDialog"), { ssr: false });

/**
 * A Base token's boost line on its page: whether it is in the Boosted lane, with how much TWIG and for how long, and
 * the button that opens the dialog. Nothing while BOOST is off. A token an admin hid says so and offers no button, so
 * nobody sends TWIG for a place it cannot get. `autoOpen` comes from /me's "Boost" link (?boost=1).
 */
export default function BoostPanel({ token, tokenId, symbol, name, initial, twigUsd, serverNow, autoOpen = false }: { token: string; tokenId: number; symbol: string; name: string; initial: TokenBoost; twigUsd: number | null; serverNow: number; autoOpen?: boolean }) {
  const { refresh } = useLive();
  const [state, setState] = useState(initial);
  const [open, setOpen] = useState(autoOpen && initial.enabled && !initial.hidden);
  const [now, setNow] = useState(serverNow);
  // a sent boost whose receipt is not read yet: kept here so a closed and reopened dialog stays locked on it
  const [pending, setPending] = useState<PendingBoost | null>(null);
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(clock);
  }, []);
  const again = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (again.current) clearTimeout(again.current);
  }, []);
  const read = useCallback(() => {
    fetch(`/api/boost?chain=${BOOST_CHAIN}&token=${token}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? setState((await r.json()) as TokenBoost) : undefined))
      .catch(() => {});
  }, [token]);
  // after a boost: read now (the machine that indexed it answers fresh) and once more after the lane's 5 s cache, for
  // a request that lands on the other machine
  const reload = useCallback(() => {
    read();
    if (again.current) clearTimeout(again.current);
    again.current = setTimeout(read, 6_000);
    refresh(); // the hero's TWIG burned
  }, [read, refresh]);

  if (!state.enabled) return null;
  const left = state.last_at ? boostTimeLeft(state.last_at, now) : null;
  const active = left !== null && BigInt(state.twig) > 0n;
  return (
    <section id="boost" aria-labelledby="boost-heading" className="scroll-mt-24 rounded-2xl border border-line bg-card px-4 py-3.5 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="boost-heading" className="flex items-center gap-2 text-sm font-semibold text-ink"><TwigMark size={16} className="rounded-[4px]" />Boost</h2>
        {active && state.place ? <span className="rounded-full border border-warm/30 bg-warm-soft px-2 py-0.5 text-[10px] font-medium text-warm-ink">#{state.place} in the lane</span> : null}
      </div>
      {state.hidden ? (
        <p className="mt-2 text-xs leading-relaxed text-muted">{BOOST_COPY.hidden}</p>
      ) : (
        <>
          <p className="mt-2 text-pretty text-xs leading-relaxed text-body">
            {active ? (
              <>Boosted with <span className="font-mono text-warm-ink tnum">{fmtBoostTwig(state.twig)}</span> in the last 24 hours<span suppressHydrationWarning> · {left}</span>.</>
            ) : (
              <>Not boosted. Sending TWIG to 0x…dEaD puts {symbol} in the Boosted lane for 24 hours.</>
            )}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <button type="button" onClick={() => setOpen(true)} className={btn.secondarySm}>{pending ? "Boost sent: check it" : "Boost with TWIG"}</button>
            {active && state.last_tx ? <a href={explorerTx(BOOST_CHAIN, state.last_tx)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[11px] text-muted hover:text-ink">Latest burn<ArrowUpRight size={11} aria-hidden="true" /></a> : null}
          </div>
        </>
      )}
      {open ? <BoostDialog token={token} tokenId={tokenId} symbol={symbol} name={name} twigUsd={twigUsd} current={BigInt(state.twig)} entry={state.entry ?? { full: false, cutoff: null }} place={state.place} pending={pending} onPending={setPending} onClose={() => setOpen(false)} onBoosted={reload} /> : null}
    </section>
  );
}
