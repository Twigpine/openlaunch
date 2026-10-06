"use client";

import Link from "next/link";
import { useState } from "react";
import { Globe } from "lucide-react";
import TokenAvatar from "./TokenAvatar";
import type { LaunchRow as L } from "@/lib/launchpad/queries";
import { ago } from "@/lib/launchpad/time";
import ChangeChip from "./ChangeChip";
import { QuoteBrandBadge } from "./MuseworldBadge";
import UnlistedPairBadge from "./UnlistedPairBadge";
import { capDisplay } from "@/lib/launchpad/market-cap";
import { addressHue } from "@/lib/launchpad/tint";
import type { ChipParts } from "@/lib/launchpad/ranking";
import { MorphAvatar, MorphName } from "./TokenMorph";
import { ChainLogo } from "./ChainLogo";
import { setPendingToken } from "@/lib/launchpad/token-transition";
import { safeSocials } from "@/lib/launchpad/socials";
import { XMark } from "./BrandMarks";
import { MagicCard } from "@/components/vendor/magic-card";
import { BorderBeam } from "@/components/vendor/border-beam";
import type { RowHighlight } from "./LaunchRow";

/**
 * The market list as cards: a banner, the token's mark over it, then only what decides a click (name, market cap,
 * ticker, change, live activity) and a buys/sells bar along the bottom edge. Volume, holders and fees stay in the
 * row view and on the token page. The name is the card's link and stretches over the whole card, so the social
 * links on the banner can be links of their own. `preview` draws the same card for the launch form: no link, no
 * page transition, no hover lift, and "now" for its age.
 */
export default function LaunchCard({ l, rank, hl = null, now, pop = false, chip = null, preview = false }: { l: L; rank?: number; hl?: RowHighlight; now: number; pop?: boolean; chip?: ChipParts | null; preview?: boolean }) {
  // one string: the compact form carries the mark for a quote with no dollar price
  const cap = capDisplay(l.fdv_quote, l.quote_usd, { key: l.quote_key, symbol: l.quote_symbol, decimals: l.quote_decimals }).compact;
  const trades = l.buys + l.sells;
  const { x, site } = safeSocials(l);
  const activity = chip ?? (hl?.kind === "new" ? { tier: "new" as const, count: null, label: "just launched", when: null, more: null } : null);

  const avatar = <TokenAvatar chain={l.chain} token={l.token} symbol={l.symbol} image={l.image_url} size={56} className="rounded-2xl" />;
  const body = (
      <article className="group/card relative flex h-full flex-col overflow-hidden rounded-[inherit] bg-card" title={l.description || `${l.name} (${l.symbol})`}>
        <div className="relative h-24 shrink-0 overflow-hidden">
          <Banner token={l.token} image={l.image_url} banner={l.banner_url} />
          {/* the cover melts into the card, so the mark and the name read on one surface */}
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-linear-to-b from-transparent via-card/45 to-card" />
          <div className="absolute left-2 top-2 flex min-w-0 items-center gap-1 pr-10">
            {rank !== undefined ? <span className={`grid h-6 min-w-6 shrink-0 place-items-center rounded-full px-1.5 text-xs font-bold tabular-nums ${rank <= 3 ? "bg-white text-black shadow-sm" : "bg-black/55 text-white ring-1 ring-white/15 backdrop-blur-md"}`}><span className="sr-only">Rank </span>{rank}</span> : null}
            <QuoteBrandBadge quoteKey={l.quote_key} />
            {l.quote_key === "other" ? <UnlistedPairBadge symbol={l.quote_symbol} className="shrink-0" /> : null}
          </div>
        </div>
        <div className="flex flex-1 flex-col px-3.5 pb-3.5">
          <div className="flex items-start gap-3">
            <span className="relative -mt-8 shrink-0 rounded-[19px] bg-card p-[3px] shadow-[0_6px_16px_-8px_rgb(0_0_0/0.45)]">
              {preview ? avatar : <MorphAvatar chain={l.chain} token={l.token}>{avatar}</MorphAvatar>}
            </span>
            <div className="min-w-0 flex-1 space-y-0.5 pt-1.5">
              <div className="flex min-w-0 items-center gap-2">
                {preview ? <span className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-ink">{l.name}</span> : <Link
                  href={`/t/${l.chain}/${l.token}`}
                  // leaves a note for the token page's loading header, so the mark and name morph on the very first frame
                  onClick={() => setPendingToken({ chain: l.chain, token: l.token, name: l.name, symbol: l.symbol, image: l.image_url })}
                  className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-ink outline-none after:absolute after:inset-0 after:z-[1] after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-brand"
                >
                  <MorphName chain={l.chain} token={l.token}><span>{l.name}</span></MorphName>
                </Link>}
                {/* above the stretched name link, so each opens its own page */}
                {x || site ? (
                  <span className="relative z-[2] ml-auto flex shrink-0 items-center gap-0.5">
                    {x ? <a href={`https://x.com/${x}`} target="_blank" rel="noopener noreferrer nofollow" aria-label={`${l.name} on X (@${x})`} title={`@${x} on X`} className={social}><XMark className="size-3" /></a> : null}
                    {site ? <a href={site} target="_blank" rel="noopener noreferrer nofollow" aria-label={`${l.name} website`} title={site} className={social}><Globe size={13} aria-hidden="true" /></a> : null}
                  </span>
                ) : null}
              </div>
              <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
                <ChainLogo chain={l.chain} size={13} />
                <span className="truncate"><span className="font-mono text-body">{l.symbol}</span><span aria-hidden="true"> · </span>{preview ? "now" : <><span className="sr-only">launched </span><time dateTime={l.block_time} title={new Date(l.block_time).toUTCString()} suppressHydrationWarning>{ago(l.block_time, now)}</time><span className="sr-only"> ago</span></>}</span>
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span key={hl?.at ?? "rest"} className={`min-w-0 truncate font-mono text-lg font-bold tracking-tight text-ink tnum ${pop ? "bb-pop" : ""}`}><span className="sr-only">Market cap </span>{cap}</span>
            <span className="shrink-0"><span className="sr-only">Change since launch </span><ChangeChip v={l.change_from_launch} /></span>
          </div>
          {activity ? <Activity chip={activity} /> : null}
        </div>
        {/* buys against sells, flush with the bottom edge; no trades draws an empty track, never an even split */}
        <div className="mt-auto flex h-[3px] shrink-0 gap-px" title={trades ? `${l.buys.toLocaleString("en-US")} buys, ${l.sells.toLocaleString("en-US")} sells` : "No trades yet"}>
          {trades ? <><span className="bg-up" style={{ width: `${(l.buys / trades) * 100}%` }} /><span className="flex-1 bg-down" /></> : <span className="flex-1 bg-line" />}
        </div>
      </article>
  );
  if (preview) return <div className="h-full rounded-2xl border border-line">{body}</div>;
  return (
    <MagicCard className="h-full rounded-2xl transition-transform duration-200 hover:-translate-y-1 motion-reduce:transition-none motion-reduce:hover:translate-y-0">
      {rank === 1 ? <BorderBeam size={110} duration={9} /> : null}
      {body}
    </MagicCard>
  );
}

const social = "grid size-7 place-items-center rounded-full text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink motion-reduce:transition-none";

/** Why the card sits where it sits: a live dot that pings, the wallet count in bold, and when the last outside trade was. */
function Activity({ chip }: { chip: ChipParts }) {
  const live = chip.tier === "live";
  return (
    <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4" suppressHydrationWarning>
      <span aria-hidden="true" className="relative flex size-1.5 shrink-0">
        {live ? <span className="absolute inset-0 animate-ping rounded-full bg-up opacity-60 motion-reduce:hidden" /> : null}
        <span className={`relative size-1.5 rounded-full ${live ? "bg-up" : chip.tier === "new" ? "bg-ink" : "bg-line-strong"}`} />
      </span>
      <span className={`truncate ${live ? "text-up" : chip.tier === "new" ? "text-ink" : "text-muted"}`}>
        {chip.count !== null ? <b className="font-semibold tabular-nums">{chip.count} </b> : null}
        {chip.label}
        {chip.when ? <span className="text-muted"> · {chip.when}</span> : null}
        {chip.more ? <span className="text-muted"> · {chip.more}</span> : null}
      </span>
    </p>
  );
}

/**
 * The creator's banner when they uploaded one. Otherwise the banner is the logo again, blown up and blurred into a
 * soft wash of its own colours. No image at all (or a broken one) falls back to the token's address hue, the same
 * colour its default mark uses, as a quiet two-tone gradient. The token page's hero wears the same cover, so the card
 * you open and the page it opens look alike.
 */
export function Banner({ token, image, banner }: { token: string; image: string | null; banner: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  const own = banner?.trim() || null;
  if (own && own !== failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={own} alt="" aria-hidden="true" referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(own)} className="absolute inset-0 size-full object-cover transition-transform duration-700 ease-out group-hover/card:scale-[1.04] motion-reduce:transition-none" />;
  }
  const src = image?.trim() || null;
  return (
    <span aria-hidden="true" className="absolute inset-0 block" style={{ background: `linear-gradient(135deg, hsl(${addressHue(token)} 55% 46%), hsl(${(addressHue(token) + 35) % 360} 50% 30%))` }}>
      {src && src !== failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(src)} className="absolute inset-0 size-full scale-[2.2] object-cover blur-2xl saturate-[1.35] transition-transform duration-700 ease-out group-hover/card:scale-[2.4] motion-reduce:transition-none" />
      ) : null}
      <span className="absolute inset-0 bg-black/15" />
    </span>
  );
}
