import { Check, CircleHelp, X, TriangleAlert } from "lucide-react";
import type { PairPrecheck } from "@/lib/launchpad/pairCheck";

/**
 * A pre-check as a list (pairCheck.ts): the hard checks every listing needs, then the flags a reviewer reads. A check
 * that could not be read says so ("?"), and never counts as a pass.
 */
export default function PrecheckReport({ p }: { p: PairPrecheck }) {
  const hard = p.checks.filter((c) => c.hard);
  const flags = p.checks.filter((c) => !c.hard);
  return (
    <div className="space-y-4 text-sm">
      <p className={`font-semibold ${p.ok ? "text-up" : "text-warm-ink"}`}>{p.ok ? `${p.symbol || "This token"} passes the free check.` : `${p.symbol || "This token"} does not pass yet.`}</p>
      <ul className="space-y-1.5">
        {hard.map((c) => (
          <li key={c.id} className="flex items-start gap-2">
            {c.pass === true ? <Check size={15} className="mt-0.5 shrink-0 text-up" aria-label="passes" /> : c.pass === false ? <X size={15} className="mt-0.5 shrink-0 text-down-ink" aria-label="fails" /> : <CircleHelp size={15} className="mt-0.5 shrink-0 text-muted" aria-label="unknown" />}
            <span className="min-w-0">
              <span className="text-ink">{c.label}</span> <span className="text-muted">{c.link ? <a href={c.link} target="_blank" rel="noopener noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">{c.value}</a> : c.value}</span>
            </span>
          </li>
        ))}
      </ul>
      {flags.length ? (
        <div>
          <p className="text-xs font-medium text-muted">For the reviewer</p>
          <ul className="mt-1.5 space-y-1.5">
            {flags.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-xs">
                {c.pass === false ? <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warm-ink" aria-label="flag" /> : <CircleHelp size={13} className="mt-0.5 shrink-0 text-muted" aria-label="note" />}
                <span className="min-w-0 text-body">
                  {c.label}: {c.link ? <a href={c.link} target="_blank" rel="noopener noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">{c.value}</a> : c.value}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-[11px] text-faint">Checked {new Date(p.at).toUTCString().replace(" GMT", " UTC")}. Holders and ages from GeckoTerminal; the second opinion from GoPlus Security.</p>
    </div>
  );
}
