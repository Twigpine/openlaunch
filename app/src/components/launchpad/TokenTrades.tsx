import { ArrowDownLeft, ArrowUpRight, Activity } from "lucide-react";
import type { SwapRow } from "@/lib/launchpad/queries";
import { explorerAddress, explorerTx, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { fmtCompact, fmtPrice, fmtQuote, fmtUsd } from "@/lib/launchpad/math";
import { ago } from "@/lib/launchpad/time";
import type { Quote } from "@/lib/launchpad/config";

/** Recent swaps straight from the pool: a side pill, the wallet, both amounts, the price and a link to each transaction. */
export default function TokenTrades({ chain, symbol, quote, swaps, now }: { chain: ChainKey; symbol: string; quote: Quote; swaps: SwapRow[]; now: number }) {
  return <section aria-label="Indexed trades">
    <div className="flex min-h-11 items-center justify-between gap-3 px-5 text-[11px] text-muted"><span>Direct from the pool</span><span className="font-mono tnum">{swaps.length} recent swaps</span></div>
    {swaps.length === 0 ? <div className="flex min-h-48 flex-col items-center justify-center gap-2 border-t border-line px-5 text-center"><Activity size={22} strokeWidth={1.4} className="mb-1 text-muted" /><h3 className="text-sm font-medium text-ink">The tape is quiet.</h3><p className="max-w-xs text-xs leading-relaxed text-muted text-pretty">No swaps have been indexed for this token yet. Confirmed trades appear here with an explorer link.</p></div> :
      <div className="max-h-[480px] overflow-auto bb-scroll" tabIndex={0} aria-label="Trade history">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 border-y border-line bg-card text-[11px] text-muted">
            <tr>
              <th className="py-2.5 pl-5 pr-3 text-left font-medium">Trade</th>
              <th className="hidden px-3 py-2.5 text-left font-medium sm:table-cell">Wallet</th>
              <th className="px-3 py-2.5 text-right font-medium">{quote.symbol}</th>
              <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">{symbol}</th>
              <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">Price</th>
              <th className="py-2.5 pl-3 pr-5 text-right font-medium">Time</th>
            </tr>
          </thead>
          <tbody>{swaps.map((s) => { const q = BigInt(s.amount0); const t = BigInt(s.amount1); const Icon = s.is_buy ? ArrowDownLeft : ArrowUpRight; const wallet = s.trader ? <a href={explorerAddress(chain, s.trader)} target="_blank" rel="noreferrer" className="font-code text-[11px] text-muted transition-colors hover:text-ink motion-reduce:transition-none" title={s.trader}>{shortAddr(s.trader)}</a> : null; return <tr key={`${s.tx_hash}:${s.log_index}`} className="border-b border-line last:border-0 transition-colors hover:bg-ink/[0.03] motion-reduce:transition-none">
            <td className="py-2.5 pl-5 pr-3">
              <span className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-semibold ${s.is_buy ? "bg-up-soft text-up" : "bg-down-soft text-down-ink"}`}><Icon size={12} aria-hidden="true" />{s.is_buy ? "Buy" : "Sell"}</span>
              {/* phones have no wallet column: the wallet sits under the side */}
              <span className="mt-1 block sm:hidden">{wallet}</span>
            </td>
            <td className="hidden px-3 py-2.5 sm:table-cell">{wallet}</td>
            <td className="px-3 py-2.5 text-right font-mono text-ink tnum">{fmtQuote(q < 0n ? -q : q, quote.decimals, "").trim()}</td>
            <td className="hidden px-3 py-2.5 text-right font-mono text-body tnum sm:table-cell">{fmtCompact(Number(t < 0n ? -t : t) / 1e18)}</td>
            <td className="hidden px-3 py-2.5 text-right font-mono text-muted tnum md:table-cell">{quote.usd !== null ? fmtUsd(s.price_quote * quote.usd) : `${fmtPrice(s.price_quote)} ${quote.symbol}`}</td>
            <td className="py-2.5 pl-3 pr-5 text-right font-mono text-muted tnum"><a href={explorerTx(chain, s.tx_hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap transition-colors hover:text-ink motion-reduce:transition-none" title={new Date(s.block_time).toUTCString()}><span className="sr-only">View transaction, </span>{ago(s.block_time, now)}<ArrowUpRight size={11} aria-hidden="true" /></a></td>
          </tr>; })}</tbody>
        </table>
      </div>}
  </section>;
}
