import { ArrowUpRight } from "lucide-react";
import { launchpad } from "@/lib/launchpad/config";
import { explorerAddress, explorerTx, type ChainKey } from "@/lib/chainPublic";

/** A receipt of the launch mechanics, not a claim about current wallet balances. Set like one: dotted leaders, mono figures. */
export default function LaunchReceipt({ chain, symbol, supply, txHash }: { chain: ChainKey; symbol: string; supply: string; txHash: string }) {
  const locker = launchpad(chain).locker;
  return <section className="overflow-hidden rounded-2xl border border-line bg-card" aria-labelledby="receipt-title">
    <div className="flex items-center justify-between gap-3 px-5 pt-4">
      <h2 id="receipt-title" className="text-sm font-semibold text-ink">The launch receipt</h2>
      <a href={explorerTx(chain, txHash)} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center gap-1 text-xs text-muted transition-colors hover:text-ink motion-reduce:transition-none" aria-label="Verify the launch transaction">Launch tx<ArrowUpRight size={12} aria-hidden="true" /></a>
    </div>
    <dl className="px-5 pb-4 pt-2 text-xs">
      <Line k="Fixed supply" v={<span title={`${supply} ${symbol}`}>{supply} {symbol}</span>} />
      <Line k="Into the pool at launch" v="100%" />
      <Line k="Liquidity" v={<a href={locker ? explorerAddress(chain, locker) : "/rules#contracts"} target={locker ? "_blank" : undefined} rel={locker ? "noreferrer" : undefined} title="An ownerless locker holds the position. Read the code." className="inline-flex items-center gap-1 text-up underline decoration-up/30 underline-offset-4 transition-colors hover:decoration-up motion-reduce:transition-none">Locked forever<ArrowUpRight size={12} aria-hidden="true" /></a>} />
      <Line k="Platform fee" v={<span className="text-up">$0</span>} />
    </dl>
    <p className="border-t border-dashed border-line-strong px-5 py-3 text-[11px] leading-relaxed text-muted text-pretty">No withdrawal key. No platform cut. This does not prevent token prices from falling.</p>
  </section>;
}

function Line({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex items-baseline gap-2 py-1.5">
    <dt className="shrink-0 text-muted">{k}</dt>
    <span aria-hidden="true" className="min-w-4 flex-1 translate-y-[-3px] border-b border-dotted border-line-strong" />
    <dd className="min-w-0 truncate font-mono font-semibold text-ink tnum">{v}</dd>
  </div>;
}
