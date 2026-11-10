"use client";

import { useTranslations } from "use-intl";
import { fmtCompact } from "@/lib/launchpad/math";
import { marketChange } from "@/lib/launchpad/market-format";
import Roll from "./Roll";

/**
 * "+12%" / "-3.4%" / "19.7×" since launch. A client component so its tooltip reads in the visitor's language wherever it
 * is drawn, the server-rendered token page included; `context` replaces "since launch" with the caller's own words.
 */
export default function ChangeChip({ v, className = "", plain = false, roll = false, context }: { v: number; className?: string; plain?: boolean; roll?: boolean; context?: string }) {
  const t = useTranslations("market.change");
  const pct = v * 100;
  const available = Number.isFinite(pct);
  const up = pct >= 0;
  const market = marketChange(v);
  // no move (it rounds to 0.0%) is neither up nor down: it reads neutral, never as a green "+0.0%"
  const flat = available && market.direction === "flat";
  // a multiple (2× and up) reads the same in both styles; smaller moves keep the pill's signed percent
  const txt = !available ? "—" : flat || market.label.endsWith("×") ? market.label : `${up ? "+" : ""}${Math.abs(pct) >= 1000 ? fmtCompact(pct, 0) : pct.toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`;
  const pillColor = !available || flat ? "bg-paper text-muted" : up ? "bg-up-soft text-up" : "bg-down-soft text-down-ink";
  return (
    <span className={`inline-flex max-w-full items-center text-[11px] font-mono font-bold tnum ${plain ? (market.direction === "flat" ? "text-muted" : market.direction === "up" ? "text-up" : "text-down-ink") : `rounded-md px-1.5 h-5 ${pillColor}`} ${className}`} title={t("title", { value: available ? `${pct}%` : "—", context: context ?? t("sinceLaunch") })}>
      <span className="truncate">{roll ? <Roll text={plain ? market.label : txt} /> : plain ? market.label : txt}</span>
    </span>
  );
}
