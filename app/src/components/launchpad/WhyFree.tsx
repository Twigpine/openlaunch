import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check } from "lucide-react";
import { ChainLogoStack } from "./ChainLogo";
import { VISIBLE_CHAINS } from "@/lib/launchpad/config";
import { MagicCard } from "@/components/vendor/magic-card";
import { BRAND_GITHUB } from "@/lib/brand";

const CONTRACTS = `${BRAND_GITHUB}/tree/main/contracts/src`;

/**
 * The home sidebar's case for the price: a $0 platform fee, where a trading fee goes (all of it to the creator's
 * wallets or burned, none to openlaunch), the fees a creator can pick, and the two contract facts behind it, each one
 * checkable in the source.
 */
export default function WhyFree() {
  return (
    <MagicCard className="rounded-2xl">
      <section aria-labelledby="free-heading" className="p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="free-heading" className="text-sm font-semibold text-ink">Why it&apos;s free</h2>
          <ChainLogoStack chains={VISIBLE_CHAINS} size={16} />
        </div>
        <p className="mt-3 flex items-baseline gap-2">
          <span className="text-4xl font-bold tracking-tight text-up tnum">$0</span>
          <span className="text-sm font-medium text-ink">platform fee</span>
        </p>
        <p className="mt-1 text-pretty text-xs leading-relaxed text-muted">On every launch and every trade, on every chain.</p>

        {/* where a trading fee goes, as the two shares it can have */}
        <div className="mt-4 rounded-xl border border-line bg-paper/60 p-3">
          <p className="text-[11px] font-medium text-body">Where a trading fee goes</p>
          <FeeShare label="The creator's wallets, or burned" pct={100} />
          <FeeShare label="openlaunch" pct={0} />
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-body">Trading fee</span>
            <span className="flex gap-1">{["0%", "1%", "3%"].map((fee) => <span key={fee} className="rounded-md border border-line bg-card px-1.5 py-px font-mono text-[11px] text-ink tnum">{fee}</span>)}</span>
          </div>
          <p className="mt-1 text-[11px] text-muted">Picked by the creator at launch</p>
        </div>

        <ul className="mt-4 space-y-2 text-xs text-body">
          {["No fee address in the factory", "No platform cut in the locker"].map((fact) => (
            <li key={fact} className="flex items-center gap-2"><span className="grid size-4 shrink-0 place-items-center rounded-full bg-up-soft text-up"><Check size={10} strokeWidth={3} aria-hidden="true" /></span>{fact}</li>
          ))}
        </ul>

        <div className="mt-4 grid grid-cols-2 gap-2 border-t border-line pt-3">
          <a href={CONTRACTS} target="_blank" rel="noopener noreferrer" className={`${action} text-body hover:text-ink`}>Read the contracts<ArrowUpRight size={12} aria-hidden="true" /></a>
          <Link href="/agents" className={`${action} text-brand hover:border-brand/40`}>Agents launch too<ArrowRight size={12} aria-hidden="true" /></Link>
        </div>
      </section>
    </MagicCard>
  );
}

/** One share of a trading fee: its label, its percent, and a bar that fills to it. */
function FeeShare({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="mt-2.5">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-muted">{label}</span>
        <span className={`shrink-0 font-mono font-semibold tnum ${pct ? "text-up" : "text-ink"}`}>{pct}%</span>
      </div>
      <div aria-hidden="true" className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
        <span className="block h-full rounded-full bg-up" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const action = "inline-flex min-h-9 items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-line px-2 text-[11px] font-medium transition-colors hover:border-line-strong motion-reduce:transition-none";
