"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Hex } from "viem";
import { CHAIN_LABELS, explorerTx, type ChainKey } from "@/lib/chainPublic";
import { syncTransaction, type TransactionSync } from "@/lib/launchpad/sync-client";
import type { FirstBuyOutcome } from "@/lib/launchpad/pending-launch";
import { fmtCompact } from "@/lib/launchpad/math";
import { btn, card } from "@/components/ui";

/** Recovery checks an existing hash only. There is deliberately no wallet dependency. */
export default function TokenRecovery({ chain, hash, reason, firstBuy, token, onResult, onArchive }: {
  chain: ChainKey; hash: Hex; reason: "pending" | "reorg" | "rebuilding" | "reference";
  firstBuy?: FirstBuyOutcome; token?: string | null;
  onResult?: (result: TransactionSync) => void;
  onArchive?: () => Promise<boolean>;
}) {
  const router = useRouter();
  const checking = useRef(false);
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const lastCheck = useRef(-Infinity);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [indexedToken, setIndexedToken] = useState<string | null>(null);
  useEffect(() => {
    alive.current = true;
    // Read-only route refreshes let the indexer's normal poll recover the page. Sync is manual, bounded to one in flight.
    const timer = reason === "reference" ? undefined : setInterval(() => { if (document.visibilityState === "visible" && !checking.current) router.refresh(); }, 15_000);
    return () => { alive.current = false; clearInterval(timer); request.current?.abort(); };
  }, [router, reason]);

  async function check() {
    if (checking.current) return;
    if (Date.now() - lastCheck.current < 15_000) {
      setNote("Please wait a few seconds before checking this transaction again.");
      return;
    }
    lastCheck.current = Date.now();
    checking.current = true;
    setBusy(true);
    request.current = new AbortController();
    const result = await syncTransaction(chain, hash, request.current.signal);
    checking.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (result.status === "applied") setIndexedToken(token ? result.tokens.find((t) => t === token) ?? null : result.tokens[0] ?? null);
    setNote(result.status === "reverted" ? "This transaction reverted. Check the transaction details before starting another launch."
      : result.status === "error" ? "The check is unavailable right now. Your transaction has not been sent again."
        : result.status === "applied" ? "This transaction is indexed. Keep its reference in case the chain history changes."
          : "Checked the existing transaction. Waiting for the token page to update.");
    onResult?.(result);
    router.refresh();
  }

  async function archive() {
    if (!onArchive || checking.current) return;
    checking.current = true;
    setBusy(true);
    let archived = false;
    try { archived = await onArchive(); } catch { /* Unavailable evidence keeps the active journal. */ }
    checking.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (!archived) setNote("The chain has not proved this transaction can no longer execute. Connect the sending wallet and check again later; the saved launch stays protected.");
  }

  const Heading = reason === "pending" || reason === "reference" ? "h2" : "h1";
  const titleId = `token-recovery-${chain}-${hash}`;
  return <div className={reason === "pending" || reason === "reference" ? "py-6" : "bb-mid bb-page py-12"}>
    <section className={`${card} mx-auto max-w-xl space-y-4 p-6`} aria-labelledby={titleId}>
      <Heading id={titleId} className="text-xl font-semibold text-ink">{reason === "pending" ? "Your launch was sent" : reason === "reference" ? "Saved launch reference" : "Checking this token’s chain history"}</Heading>
      <p className="text-sm leading-relaxed text-body">{reason === "pending"
        ? `The token page is not ready yet on ${CHAIN_LABELS[chain]}. Keep this transaction to check its progress.`
        : reason === "reference" ? `Keep this ${CHAIN_LABELS[chain]} transaction for later checks. An earlier confirmation or indexing result does not guarantee its block can never change.`
          : reason === "rebuilding" ? "We are rebuilding this token’s history from the chain. Its market and trading controls will return when its launch is indexed."
          : "The block containing this launch changed. We are checking whether the transaction returns to the chain before showing its market again."}</p>
      <p className="text-sm text-body">Checking again only checks the existing transaction. It never sends another launch.</p>
      <a href={explorerTx(chain, hash)} target="_blank" rel="noreferrer" className="block break-all font-code text-xs text-brand underline">View transaction {hash}</a>
      {firstBuy ? <div className="space-y-2 border-t border-line pt-3 text-sm text-body">
        <p>{firstBuy.status === "confirmed" ? `First buy confirmed${firstBuy.amount ? `: ${firstBuy.exact ? "" : "about "}${fmtCompact(Number(firstBuy.amount) / 1e18)} ${firstBuy.symbol}` : ""}.`
          : firstBuy.status === "reverted" ? "The first buy reverted on-chain."
            : firstBuy.status === "replaced" ? "The first buy was replaced by another transaction. Review its outcome in your wallet."
              : "The first buy was sent; its outcome is not confirmed here. Check it before buying again."}</p>
        <a href={explorerTx(chain, firstBuy.hash)} target="_blank" rel="noreferrer" className="block break-all font-code text-xs text-brand underline">View first-buy transaction {firstBuy.hash}</a>
      </div> : null}
      <div className="flex flex-wrap items-center gap-3"><button type="button" onClick={() => void check()} disabled={busy} className={btn.primarySm}>{busy ? "Checking…" : "Check again"}</button><Link href="/" className={btn.secondarySm}>Back to tokens</Link></div>
      {indexedToken ? <Link href={`/t/${chain}/${indexedToken}`} className={btn.secondarySm}>Open token page</Link> : null}
      {onArchive ? <div className="space-y-2 border-t border-line pt-3">
        <p className="text-xs leading-relaxed text-muted">You can start a different launch only after this wallet’s finalized transaction count proves the saved transaction cannot execute in the future. This does not mean it failed; its reference and any first-buy result stay saved.</p>
        <button type="button" onClick={() => void archive()} disabled={busy} className={btn.secondarySm}>Keep reference and start another launch</button>
      </div> : null}
      {note ? <p role="status" className="text-sm text-muted">{note}</p> : null}
    </section>
  </div>;
}
