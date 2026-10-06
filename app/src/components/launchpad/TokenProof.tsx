import { ArrowUpRight, Coins, LockKeyhole, UserRound, UsersRound, Zap, type LucideIcon } from "lucide-react";
import type { ProofFact, ProofKey } from "@/lib/launchpad/proof";
import { fmtShare } from "@/lib/launchpad/holders";

const ICON: Record<ProofKey, LucideIcon> = { lock: LockKeyhole, creator: UserRound, spread: UsersRound, launch: Zap, fees: Coins };
/** A good fact reads green, a plain one in the token's colour, one worth a second look in amber. */
const TONE: Record<ProofFact["tone"], string> = {
  good: "bg-up-soft text-up",
  info: "bg-paper text-[color:var(--tok,var(--color-ink))] ring-1 ring-line",
  warn: "bg-warm-soft text-warm-ink",
};
export type ProofLink = { href: string; label: string; external?: boolean };

/**
 * The token's Proof panel (server component): five facts read from the chain, one line each, with a link to check
 * it. No score. A fact worth a second look is marked in amber, using the same thresholds as the Holders tab.
 */
export default function TokenProof({ facts, holdersReady, links, bar }: { facts: ProofFact[]; holdersReady: boolean; links: Partial<Record<ProofKey, ProofLink>>; bar: { top10Bps: number; poolBps: number } | null }) {
  return (
    <section aria-labelledby="proof-heading" className="min-w-0 overflow-hidden rounded-2xl border border-line bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-3.5">
        <h2 id="proof-heading" className="text-sm font-semibold text-ink">Proof</h2>
        <span className="text-[11px] text-muted">Every line links to where you can check it</span>
      </div>
      <ul className="divide-y divide-line">
        {facts.map((fact) => {
          const Icon = ICON[fact.key];
          const link = links[fact.key];
          return (
            <li key={fact.key} className="flex gap-3.5 px-5 py-4">
              <span className={`grid size-8 shrink-0 place-items-center rounded-full ${TONE[fact.tone]}`}><Icon size={15} aria-hidden="true" /></span>
              {/* the link reads last, after the fact and its detail; from sm up it moves beside the title */}
              <div className="grid min-w-0 flex-1 grid-cols-1 gap-x-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                <p className={`text-sm font-semibold sm:col-start-1 sm:row-start-1 ${fact.tone === "warn" ? "text-warm-ink" : "text-ink"}`}>{fact.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted text-pretty sm:col-span-2">{fact.detail}</p>
                {fact.key === "spread" && bar ? <div className="sm:col-span-2"><SupplyBar {...bar} /></div> : null}
                {link ? (
                  <a href={link.href} {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})} className="mt-2 inline-flex items-center gap-1 justify-self-start whitespace-nowrap text-xs text-muted transition-colors hover:text-ink motion-reduce:transition-none sm:col-start-2 sm:row-start-1 sm:mt-0 sm:justify-self-end sm:self-baseline">
                    {link.label}{link.external ? <ArrowUpRight size={12} aria-hidden="true" /> : null}
                  </a>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {!holdersReady ? <p className="border-t border-line px-5 py-3 text-[11px] leading-relaxed text-muted text-pretty">Creator holdings, holder spread and launch-window buyers appear once this token&apos;s transfer history is indexed. Missing data is not a clean bill of health.</p> : null}
    </section>
  );
}

/** Where the supply sits: the ten largest wallets, then the locked pool, then everyone else, each with its share. */
function SupplyBar({ top10Bps, poolBps }: { top10Bps: number; poolBps: number }) {
  const top = Math.max(0, Math.min(10_000, top10Bps));
  const pool = Math.max(0, Math.min(10_000 - top, poolBps));
  const rest = 10_000 - top - pool;
  const parts = [
    { label: "Top 10 wallets", bps: top, swatch: { background: "var(--tok, var(--color-ink))" }, className: "" },
    { label: "Locked pool", bps: pool, swatch: undefined, className: "bg-muted/50" },
    { label: "Everyone else", bps: rest, swatch: undefined, className: "bg-line-strong" },
  ];
  return (
    <div className="mt-3">
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
        {parts.map((part) => part.bps > 0 ? <span key={part.label} className={`h-full ${part.className}`} style={{ width: `${part.bps / 100}%`, ...part.swatch }} /> : null)}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {parts.map((part) => (
          <li key={part.label} className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${part.className}`} style={part.swatch} aria-hidden="true" />
            {part.label} <span className="font-mono text-body tnum">{fmtShare(part.bps)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
