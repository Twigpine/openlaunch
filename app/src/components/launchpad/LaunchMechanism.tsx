"use client";

import { ArrowUpRight, ChevronDown } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { useLive } from "./LiveProvider";
import LiveNumber, { COMPACT_USD } from "../LiveNumber";
import { GitlawbMark } from "./GitlawbBadge";
import { TwigMark } from "./TwigBadge";
import { fmtQuote, fmtUnitsExact, fmtUsd } from "@/lib/launchpad/math";
import { GITLAWB_DECIMALS, GITLAWB_SYMBOL } from "@/lib/launchpad/gitlawb";
import { TWIG_DECIMALS, TWIG_SYMBOL } from "@/lib/launchpad/twig";
import { BRAND_GITHUB } from "@/lib/brand";
import { CHAIN_KEYS, CHAIN_SHORT, chainList } from "@/lib/chainPublic";
import { VISIBLE_CHAINS } from "@/lib/launchpad/config";
import { ChainLogoStack } from "./ChainLogo";

/** The network's real totals as a live panel: the launch count large, four tiles under it. The full breakdown sits behind a toggle. */
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
  return <div>
    <div className="flex items-center justify-between gap-3">
      <p className="flex items-center gap-2 text-xs font-medium text-body">
        {/* the totals follow the shared live poll */}
        <span aria-hidden="true" className="relative flex size-2"><span className="absolute inset-0 animate-ping rounded-full bg-up opacity-50 motion-reduce:hidden" /><span className="relative size-2 rounded-full bg-up" /></span>
        Live across <ChainLogoStack chains={VISIBLE_CHAINS} size={16} />
      </p>
      <span className="text-[11px] text-muted">All time</span>
    </div>
    <p className="mt-5">
      <span className="block font-mono text-5xl font-bold tracking-[-0.04em] text-ink tnum">{count(t.launches)}</span>
      <span className="mt-1.5 block text-sm text-muted">tokens launched</span>
    </p>
    {/* hairlines between the tiles come from the gap over a line-coloured grid */}
    <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line">
      <Tile k="trades">{count(t.trades)}</Tile>
      <Tile k="traded" title={usdNote ?? fmtUsd(t.volume_usd)}>{usd(t.volume_usd, true)}</Tile>
      <Tile k="in fees to the wallets creators chose" title={usdNote ?? fmtUsd(t.fees_to_creators_usd)} accent>{usd(t.fees_to_creators_usd, true)}</Tile>
      <Tile k="to us" accent>$0</Tile>
    </dl>
    {/* the breakdown opens over the page, so the hero never shifts when it opens or closes */}
    <Popover.Root>
      <Popover.Trigger className="group mt-3 flex min-h-9 w-fit cursor-pointer items-center gap-1.5 text-xs text-muted transition-colors hover:text-ink data-[popup-open]:text-ink motion-reduce:transition-none">
        The numbers across {chainList("&", CHAIN_SHORT)}
        <ChevronDown size={13} aria-hidden="true" className="transition-transform duration-200 group-data-[popup-open]:rotate-180 motion-reduce:transition-none" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={12} className="z-50">
          <Popover.Popup className="w-[min(24rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-2xl border border-line bg-raised p-5 shadow-dialog outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 motion-reduce:transition-none">
            <Popover.Title className="text-sm font-semibold text-ink">The numbers across {chainList("&", CHAIN_SHORT)}</Popover.Title>
            <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 border-t border-dashed border-line-strong pt-4 text-xs">
              {CHAIN_KEYS.map((k) => <div key={k}><dt className="text-muted">{CHAIN_SHORT[k]} launches</dt><dd className="mt-1 font-mono text-ink tnum">{count(t.by_chain[k]?.launches ?? 0)}</dd></div>)}
              <div><dt className="text-muted">All-time trades</dt><dd className="mt-1 font-mono text-ink tnum">{count(t.trades)}</dd></div>
              <div><dt className="text-muted">All-time volume</dt><dd className="mt-1 font-mono text-ink tnum" title={usdNote}>{usd(t.volume_usd)}</dd></div>
              <div><dt className="text-muted">Fees to recipients</dt><dd className="mt-1 font-mono text-up tnum" title={usdNote}>{usd(t.fees_to_creators_usd)}</dd></div>
              <div><dt className="text-muted">Fees burned</dt><dd className="mt-1 font-mono text-warm-ink tnum" title={usdNote}>{usd(t.fees_burned_usd)}</dd></div>
              <div className="col-span-2"><dt className="flex items-center gap-1.5 text-muted" title="Sent to 0x…dEaD by GITLAWB-quoted launches on Base and Robinhood Chain"><GitlawbMark size={14} />GITLAWB burned</dt><dd className="mt-1 font-mono text-warm-ink tnum" title={gitlawbBurnedExact}>{fmtQuote(t.gitlawb_burned, GITLAWB_DECIMALS, GITLAWB_SYMBOL)}</dd></div>
              {BigInt(twigBurned) > 0n ? <div className="col-span-2"><dt className="flex items-center gap-1.5 text-muted" title="Sent to 0x…dEaD by TWIG-quoted launches on Base"><TwigMark size={14} />TWIG burned</dt><dd className="mt-1 font-mono text-warm-ink tnum" title={twigBurnedExact}>{fmtQuote(twigBurned, TWIG_DECIMALS, TWIG_SYMBOL)}</dd></div> : null}
            </dl>
            <p className="mt-4 text-pretty text-[11px] leading-relaxed text-muted">Creators choose a 0%, 1% or 3% trading fee. It goes to their named recipients or is burned. The platform takes none: no fee address in the factory, no platform cut in the locker.</p>
            <a href={`${BRAND_GITHUB}/tree/main/contracts/src`} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-9 items-center gap-1 text-xs font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">Read the contracts<ArrowUpRight size={12} aria-hidden="true" /></a>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}

/** One total: the figure large, what it counts under it (the label stays first for assistive tech). */
function Tile({ children, k, title, accent = false }: { children: React.ReactNode; k: string; title?: string; accent?: boolean }) {
  return (
    <div title={title} className="flex flex-col-reverse justify-end bg-card/95 px-3.5 py-3">
      <dt className="mt-0.5 text-pretty text-[11px] leading-snug text-muted">{k}</dt>
      <dd className={`whitespace-nowrap font-mono text-xl font-bold tracking-[-0.03em] tnum ${accent ? "text-up" : "text-ink"}`}>{children}</dd>
    </div>
  );
}
