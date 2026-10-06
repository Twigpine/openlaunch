import { fmtCompact } from "@/lib/launchpad/math";
import { marketChange } from "@/lib/launchpad/market-format";

/** "+12%" / "-3.4%" / "19.7×" since launch. Plain component: renders on the server and the client. */
export default function ChangeChip({ v, className = "", plain = false, context = "since launch" }: { v: number; className?: string; plain?: boolean; context?: string }) {
  const pct = v * 100;
  const available = Number.isFinite(pct);
  const up = pct >= 0;
  const market = marketChange(v);
  // a multiple (2× and up) reads the same in both styles; smaller moves keep the pill's signed percent
  const txt = !available ? "—" : market.label.endsWith("×") ? market.label : `${up ? "+" : ""}${Math.abs(pct) >= 1000 ? fmtCompact(pct, 0) : pct.toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`;
  const pillColor = !available ? "bg-paper text-muted" : up ? "bg-up-soft text-up" : "bg-down-soft text-down-ink";
  return (
    <span className={`inline-flex max-w-full items-center text-[11px] font-mono font-bold tnum ${plain ? (market.direction === "flat" ? "text-muted" : market.direction === "up" ? "text-up" : "text-down-ink") : `rounded-md px-1.5 h-5 ${pillColor}`} ${className}`} title={`${available ? `${pct}%` : "—"} ${context}`}>
      <span className="truncate">{plain ? market.label : txt}</span>
    </span>
  );
}
