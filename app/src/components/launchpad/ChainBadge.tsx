import { CHAIN_LABELS, CHAIN_SHORT, type ChainKey } from "@/lib/chainPublic";

const TONES: Record<ChainKey, string> = { base: "bg-brand-soft text-brand border-brand/20", robinhood: "bg-up-soft text-up border-up/20", arc: "bg-paper text-ink border-line-strong", elysium: "bg-paper text-ink border-line-strong" };

/** Tiny chain label. Text only — no third-party logos. */
export default function ChainBadge({ chain, className = "", size = "sm" }: { chain: ChainKey; className?: string; size?: "sm" | "md" }) {
  return (
    <span className={`inline-flex items-center rounded-md border font-semibold whitespace-nowrap ${size === "md" ? "h-6 px-2 text-[11px]" : "h-5 px-1.5 text-[10px] uppercase tracking-wide"} ${TONES[chain]} ${className}`} title={CHAIN_LABELS[chain]}>
      {CHAIN_SHORT[chain]}
    </span>
  );
}
