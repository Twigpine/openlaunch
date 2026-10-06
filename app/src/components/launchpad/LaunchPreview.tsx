"use client";

import { useState, type CSSProperties } from "react";
import { Globe, ImagePlus, LayoutGrid, PanelTop } from "lucide-react";
import LaunchCard from "./LaunchCard";
import TokenAvatar from "./TokenAvatar";
import { ChainLogo } from "./ChainLogo";
import { XMark } from "./BrandMarks";
import { QuoteBrandBadge } from "./MuseworldBadge";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import { capDisplay } from "@/lib/launchpad/market-cap";
import { safeSocials } from "@/lib/launchpad/socials";
import { fallbackTint } from "@/lib/launchpad/tint";
import { CHAIN_LABELS } from "@/lib/chainPublic";
import type { LaunchRow } from "@/lib/launchpad/queries";
import type { ChipParts } from "@/lib/launchpad/ranking";

const JUST_LAUNCHED: ChipParts = { tier: "new", count: null, label: "just launched", when: null, more: null };

type View = "card" | "page";

/**
 * What the launch will look like, from the form as it is being filled: the real market card it gets on the board, or
 * the top of its token page. Both views sit in one grid cell, so the panel always has the taller one's height and
 * switching never moves the form beside it.
 */
export default function LaunchPreview({ row }: { row: LaunchRow }) {
  const [view, setView] = useState<View>("card");
  // the hidden view keeps its space but leaves the accessibility tree (visibility: hidden)
  const layer = (v: View) => `col-start-1 row-start-1 min-w-0 transition-[opacity,visibility] duration-200 motion-reduce:transition-none ${view === v ? "" : "invisible opacity-0"}`;
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Preview</p>
        <ToggleGroup aria-label="Preview" value={[view]} onValueChange={(values) => { const next = values[0]; if (next === "card" || next === "page") setView(next); }} className="rounded-[9px] p-0.5">
          <ToggleGroupItem value="card" className="min-h-6 rounded-[7px] px-2 text-[11px]"><LayoutGrid size={12} aria-hidden="true" />On the board</ToggleGroupItem>
          <ToggleGroupItem value="page" className="min-h-6 rounded-[7px] px-2 text-[11px]"><PanelTop size={12} aria-hidden="true" />Token page</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="mt-3 grid">
        <div className={layer("card")}><LaunchCard preview l={row} now={0} chip={JUST_LAUNCHED} /></div>
        <div className={layer("page")}><PagePreview row={row} /></div>
      </div>
    </div>
  );
}

/**
 * The top of the token page in miniature, laid out like the page: the banner when there is one, the ringed mark and
 * name beside the opening market cap, then the description and links.
 */
function PagePreview({ row }: { row: LaunchRow }) {
  const cap = capDisplay(row.fdv_quote, row.quote_usd, { key: row.quote_key, symbol: row.quote_symbol, decimals: row.quote_decimals }).compact;
  const { x, host } = safeSocials(row);
  // the page rings the mark in the logo's colour; with no logo yet that is the generated mark's own hue
  const tint = row.image_url ? null : fallbackTint(row.token);
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-paper p-3">
      {row.banner_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={row.banner_url} alt="" referrerPolicy="no-referrer" className="h-12 w-full shrink-0 rounded-xl border border-line object-cover" />
      ) : (
        // the page draws no banner without one; the empty slot only shows where it would go
        <p className="flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-dashed border-line text-[10px] text-muted"><ImagePlus size={12} aria-hidden="true" />No banner yet</p>
      )}
      <div className="mt-2.5 flex min-w-0 items-center gap-2.5">
        <span
          className={`shrink-0 rounded-[13px] border-2 p-[2px] ${tint ? "[--tok:var(--tok-light)] dark:[--tok:var(--tok-dark)]" : "border-line"}`}
          style={tint ? ({ borderColor: "var(--tok)", "--tok-light": tint.light, "--tok-dark": tint.dark } as CSSProperties) : undefined}
        >
          <TokenAvatar chain={row.chain} token={row.token} symbol={row.symbol} image={row.image_url} size={36} className="rounded-[9px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="min-w-0 truncate font-display text-[15px] font-bold tracking-tight text-ink">{row.name}</p>
            <QuoteBrandBadge quoteKey={row.quote_key} />
          </div>
          <p className="flex min-w-0 items-center gap-1 text-[11px] text-muted">
            <span className="max-w-28 truncate font-mono text-body">{row.symbol}</span> on <ChainLogo chain={row.chain} size={12} /><span className="truncate">{CHAIN_LABELS[row.chain]}</span>
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[10px] text-muted">Opens at</p>
          <p className="font-mono text-sm font-bold text-ink tnum">{cap}</p>
        </div>
      </div>
      <p className={`mt-2 line-clamp-2 text-[11px] leading-snug ${row.description ? "text-body" : "text-muted"}`}>{row.description ?? "Add a description so traders know what this is."}</p>
      {x || host ? (
        <div className="mt-2 flex min-w-0 gap-1.5">
          {x ? <span className={chip}><XMark className="size-2.5" />@{x}</span> : null}
          {host ? <span className={chip}><Globe size={11} aria-hidden="true" /><span className="truncate">{host}</span></span> : null}
        </div>
      ) : null}
    </div>
  );
}

const chip = "inline-flex min-w-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] font-medium text-body";
