import { UsersRound } from "lucide-react";
import type { HolderPanel } from "@/lib/launchpad/holdersServer";
import { holderFactsAvailable } from "@/lib/launchpad/token-market";
import { fmtShare } from "@/lib/launchpad/holders";
import { fmtCompact } from "@/lib/launchpad/math";
import { explorerAddress, shortAddr, type ChainKey } from "@/lib/chainPublic";

/**
 * Holders & trust panel (server component). Facts only — no score: who holds the supply, what the
 * creator did, who bought in the launch window, and how much sits in the locked pool.
 */
const TAG_STYLE: Record<string, string> = {
  creator: "border-brand/40 bg-brand-soft text-brand",
  pool: "border-line bg-paper text-muted",
  burn: "border-line bg-paper text-muted",
  sniper: "border-warm/40 bg-warm-soft text-warm-ink",
  whale: "border-line-strong bg-card text-ink",
};
/** Tags read as words in sentence case, not shouted labels. */
const TAG_LABEL: Record<string, string> = { creator: "Creator", pool: "Pool", burn: "Burn", sniper: "Sniper", whale: "Whale" };
const NOTE_STYLE = { warn: "border-warm/40 bg-warm-soft text-warm-ink", info: "border-line bg-card text-body", good: "border-holder-good-line bg-holder-good-bg text-up" } as const;

export default function HoldersPanel({ chain, symbol, p, embedded = false }: { chain: ChainKey; symbol: string; p: HolderPanel | null; embedded?: boolean }) {
  if (!p || !holderFactsAvailable(p)) return <section aria-label="holders" className={embedded ? "p-5" : "rounded-2xl border border-line bg-paper p-5"}><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold text-ink">Supply distribution</h2><span className="text-[11px] text-muted">Awaiting transfer history</span></div><div className="flex min-h-44 flex-col items-center justify-center gap-2 text-center"><UsersRound size={24} strokeWidth={1.4} className="mb-1 text-muted" /><h3 className="text-sm font-medium text-ink">The holder picture is not ready yet.</h3><p className="max-w-sm text-xs leading-relaxed text-muted text-pretty">Concentration, creator holdings and early buyers appear after transfer history is indexed. Missing data is not a clean bill of health.</p></div></section>;
  const supply = Number(BigInt(p.supply)) / 1e18;
  return (
    <section className={embedded ? "overflow-hidden" : "overflow-hidden rounded-2xl border border-line bg-card"} aria-label="holders">
      <div className="px-5 pt-4 pb-3 flex items-baseline justify-between gap-3 flex-wrap">
        {/* inside the Holders tab the tab already names the panel; the heading stays for the document outline */}
        <h2 className={embedded ? "sr-only" : "text-sm font-semibold text-ink"}>Holders</h2>
        <span className="text-[11px] text-muted">{p.synced ? "From every transfer of the token, live" : "Indexing transfer history…"}</span>
      </div>
      <dl className="px-5 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Stat k="Holders" v={`${p.holders}`} />
        <Stat k="Top 10 hold" v={fmtShare(p.top10Bps)} warn={p.top10Bps >= 5000} />
        <Stat k="Creator holds" v={fmtShare(p.creator.bps)} sub={p.creator.sells > 0 ? `sold ${p.creator.sells}×` : "never sold"} warn={p.creator.bps >= 2000 || p.creator.sells > 0} />
        <Stat k="Sniped at launch" v={fmtShare(p.sniper.bps)} sub={`${p.sniper.wallets} wallet${p.sniper.wallets === 1 ? "" : "s"}`} warn={p.sniper.bps >= 1000} />
      </dl>
      <ul className="px-5 pt-3 flex flex-wrap gap-1.5">
        {p.notes.filter((n) => !n.text.includes("no red flags")).map((n) => (
          <li key={n.text} className={`inline-flex items-center h-6 px-2 rounded-full border text-[11px] font-medium ${NOTE_STYLE[n.level]}`}>
            {n.text}
          </li>
        ))}
      </ul>
      {p.top.length > 0 ? (
        <ol className="mt-3 border-t border-line divide-y divide-line">
          {p.top.map((h, i) => (
            <li key={h.address} className="px-5 py-2.5 flex items-center gap-3 text-sm transition-colors hover:bg-ink/[0.03] motion-reduce:transition-none">
              <span className="w-5 text-right font-mono text-xs text-muted tnum">{i + 1}</span>
              <a href={explorerAddress(chain, h.address)} target="_blank" rel="noreferrer" className="font-code text-xs text-body hover:text-ink" title={h.address}>
                {shortAddr(h.address)}
              </a>
              <span className="flex gap-1">
                {h.tags.map((t) => (
                  <span key={t} className={`inline-flex items-center h-5 px-1.5 rounded-md border text-[10px] font-medium ${TAG_STYLE[t]}`}>
                    {TAG_LABEL[t] ?? t}
                  </span>
                ))}
              </span>
              <span className="ml-auto flex items-center gap-2 min-w-0">
                <span className="hidden sm:block h-1.5 w-24 rounded-full bg-line overflow-hidden" aria-hidden>
                  <span className="block h-full rounded-full bg-[color:var(--tok,var(--color-ink))]" style={{ width: `${Math.min(100, h.bps / 100)}%` }} />
                </span>
                <span className="font-mono tnum text-xs text-muted hidden md:inline">{fmtCompact(Number(BigInt(h.balance)) / 1e18, 1)}</span>
                <span className="font-mono tnum font-semibold text-ink w-14 text-right">{fmtShare(h.bps)}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-5 pb-4 pt-3 text-sm text-muted">{p.synced ? `Nobody holds ${symbol} outside the pool yet.` : "Holder list appears once the transfer history is indexed."}</p>
      )}
      <p className="px-5 py-3 text-[11px] text-muted border-t border-line">
        {fmtShare(p.poolBps)} of the {fmtCompact(supply, 0)} supply is in the locked Uniswap v4 pool. Pool, locker and burn addresses are never counted as holders.
      </p>
    </section>
  );
}

function Stat({ k, v, sub, warn }: { k: string; v: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 min-w-0 ${warn ? "border-warm/40 bg-warm-soft" : "border-line bg-paper"}`}>
      <dt className="text-[11px] text-muted truncate">{k}</dt>
      <dd className={`font-mono font-bold tnum truncate ${warn ? "text-warm-ink" : "text-ink"}`}>{v}</dd>
      {sub ? <dd className="text-[11px] font-mono text-muted truncate">{sub}</dd> : null}
    </div>
  );
}
