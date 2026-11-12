"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Hex } from "viem";
import { CHAIN_LABELS, explorerTx, type ChainKey } from "@/lib/chainPublic";
import { syncTransaction, type TransactionSync } from "@/lib/launchpad/sync-client";
import { btn, card } from "@/components/ui";

/** Recovery checks an existing hash only. There is deliberately no wallet dependency. */
export default function TokenRecovery({ chain, hash, reason, onResult }: {
  chain: ChainKey; hash: Hex; reason: "pending" | "reorg" | "rebuilding";
  onResult?: (result: TransactionSync) => void;
}) {
  const router = useRouter();
  const checking = useRef(false);
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const lastCheck = useRef(-Infinity);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    alive.current = true;
    // Read-only route refreshes let the indexer's normal poll recover the page. Sync is manual, bounded to one in flight.
    const timer = setInterval(() => { if (document.visibilityState === "visible" && !checking.current) router.refresh(); }, 15_000);
    return () => { alive.current = false; clearInterval(timer); request.current?.abort(); };
  }, [router]);

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
    setNote(result.status === "reverted" ? "This transaction reverted. Check the transaction details before starting another launch."
      : result.status === "error" ? "The check is unavailable right now. Your transaction has not been sent again."
        : "Checked the existing transaction. Waiting for the token page to update.");
    onResult?.(result);
    router.refresh();
  }

  const Heading = reason === "pending" ? "h2" : "h1";
  return <div className={reason === "pending" ? "py-6" : "bb-mid bb-page py-12"}>
    <section className={`${card} mx-auto max-w-xl space-y-4 p-6`} aria-labelledby="token-recovery-title">
      <Heading id="token-recovery-title" className="text-xl font-semibold text-ink">{reason === "pending" ? "Your launch was sent" : "Checking this token’s chain history"}</Heading>
      <p className="text-sm leading-relaxed text-body">{reason === "pending"
        ? `The token page is not ready yet on ${CHAIN_LABELS[chain]}. Keep this transaction to check its progress.`
        : reason === "rebuilding" ? "We are rebuilding this token’s history from the chain. Its market and trading controls will return when its launch is indexed."
          : "The block containing this launch changed. We are checking whether the transaction returns to the chain before showing its market again."}</p>
      <p className="text-sm text-body">Checking again only checks the existing transaction. It never sends another launch.</p>
      <a href={explorerTx(chain, hash)} target="_blank" rel="noreferrer" className="block break-all font-code text-xs text-brand underline">View transaction {hash}</a>
      <div className="flex flex-wrap items-center gap-3"><button type="button" onClick={() => void check()} disabled={busy} className={btn.primarySm}>{busy ? "Checking…" : "Check again"}</button><Link href="/" className={btn.secondarySm}>Back to tokens</Link></div>
      {note ? <p role="status" className="text-sm text-muted">{note}</p> : null}
    </section>
  </div>;
}
