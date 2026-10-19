"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConfig, useChainId, useReadContract, useSwitchChain } from "wagmi";
import { getPublicClient, getWalletClient } from "wagmi/actions";
import { walletOnChain } from "@/lib/walletOnChain";
import type { Hex } from "viem";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { btn, card, helper, input } from "@/components/ui";
import { BUILDER_DATA_SUFFIX, CHAINS, CHAIN_LABELS, explorerAddress, explorerTx, shortAddr } from "@/lib/chainPublic";
import { ERC20_MIN_ABI, ERC20_TRANSFER_ABI } from "@/lib/launchpad/abi";
import { DEAD } from "@/lib/launchpad/config";
import { TWIG_ADDRESS, TWIG_WRAP_URL } from "@/lib/launchpad/twig";
import { nowMs } from "@/lib/launchpad/time";
import { nonce } from "@/lib/nonce";
import { friendlyError } from "@/lib/errors";
import { PAIR_FEE_CHAIN, pairPath } from "@/lib/launchpad/pairs";
import { PAIR_APPLY_COPY, buildPairApplyMessage, pairApplicationOf, proofPostText, proofPostUrl, type PairApplyAction } from "@/lib/launchpad/pairApply";
import { intentUrl } from "@/lib/profiles/xpost";
import type { PairApplicationPublic } from "@/lib/launchpad/pairApplyServer";
import PrecheckReport from "./PrecheckReport";

/** The fee is TWIG on Base and every signature here is made on Base, whatever chain the token is on. */
const FEE_CHAIN = PAIR_FEE_CHAIN;
const BASE = CHAINS[FEE_CHAIN];
const group = (v: string | bigint) => BigInt(v).toLocaleString("en-US");

/**
 * One application, for its applicant and for anyone who opens it: the proof post, the fee (quote, lock, one TWIG
 * transfer to 0x…dEaD that names the application), the review and its outcome. The page reloads the application
 * every 15 seconds, so a burn the indexer records or a decision shows without a refresh.
 */
export default function PairApplication({ initial, open }: { initial: PairApplicationPublic; open: boolean }) {
  const config = useConfig();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { address } = useHydratedAccount();
  const [app, setApp] = useState(initial);
  const [proof, setProof] = useState(initial.proof_url ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // a transfer this browser sent for this application: until the indexer records it, nothing offers to send again
  const sentKey = `pair-fee-sent:${initial.id}`;
  const [sent, setSent] = useState<Hex | null>(null);
  // read after mount (the server render has no storage): a reload mid-indexing still shows "Sent", never the button
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        const v = window.sessionStorage.getItem(sentKey);
        if (v && /^0x[0-9a-f]{64}$/i.test(v)) setSent(v as Hex);
      } catch {
        // storage unavailable
      }
    }, 0);
    return () => clearTimeout(id);
  }, [sentKey]);
  const remember = (h: Hex | null) => {
    setSent(h);
    try {
      if (h) window.sessionStorage.setItem(sentKey, h);
      else window.sessionStorage.removeItem(sentKey);
    } catch {
      // storage unavailable: the in-memory guard still holds for this page
    }
  };
  const [now, setNow] = useState(() => nowMs());
  const lock = useRef(false);
  const mine = Boolean(address && address.toLowerCase() === app.applicant);
  const bal = useReadContract({ address: TWIG_ADDRESS, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: address ? [address] : undefined, chainId: BASE.id, query: { enabled: Boolean(address) && app.status === "open", refetchInterval: 15_000 } });

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/pairs/application/${app.id}`, { cache: "no-store" });
      if (res.ok) setApp((await res.json()) as PairApplicationPublic);
    } catch {
      // keep what is shown
    }
  }, [app.id]);
  useEffect(() => {
    // the sent transfer is in the application's burns: the guard has done its job
    if (sent && app.burns.some((b) => b.tx_hash === sent.toLowerCase())) {
      try {
        window.sessionStorage.removeItem(sentKey);
      } catch {
        // nothing stored
      }
    }
  }, [app.burns, sent, sentKey]);
  useEffect(() => {
    const t = setInterval(() => {
      setNow(nowMs());
      void reload();
    }, 15_000);
    const s = setInterval(() => setNow(nowMs()), 1_000);
    return () => {
      clearInterval(t);
      clearInterval(s);
    };
  }, [reload]);

  async function sign(action: PairApplyAction, extra: { proof?: string }) {
    if (!address || busy) return;
    setBusy(action);
    setMsg(null);
    try {
      const n = nonce();
      const ts = nowMs();
      const wallet = await walletOnChain(config, BASE.id);
      const signature = await wallet.signMessage({ message: buildPairApplyMessage({ action, chain: app.chain, address: app.address, wallet: address, nonce: n, ts, id: app.id, ...extra }) });
      const res = await fetch("/api/pairs/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, chain: app.chain, address: app.address, id: app.id, wallet: address, nonce: n, ts, signature, ...extra }) });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `request failed (HTTP ${res.status})`);
      setMsg({ ok: true, text: action === "proof" ? "Proof post saved." : "Sent back for review." });
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    } finally {
      setBusy(null);
    }
  }

  /** Ask the server to index the sent transfer now (the receipt path), then reload. Never sends anything. */
  async function recheck() {
    if (!sent || busy) return;
    setBusy("recheck");
    try {
      await fetch(`/api/launch/sync?chain=${FEE_CHAIN}&tx=${sent}`, { method: "POST" }).catch(() => {});
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function getQuote() {
    if (busy) return;
    setBusy("quote");
    setMsg(null);
    try {
      const res = await fetch(`/api/pairs/application/${app.id}/quote`, { method: "POST" });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `request failed (HTTP ${res.status})`);
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    } finally {
      setBusy(null);
    }
  }

  async function pay() {
    const q = app.quote;
    if (!address || !q || lock.current || waiting) return;
    // the amount must name THIS application in its last digits: never send TWIG that would pay for another one
    if (pairApplicationOf(BigInt(q.amount)) !== app.id) {
      setMsg({ ok: false, text: "That amount does not name this application. Nothing was sent." });
      return;
    }
    lock.current = true; // before the first await: one transfer per click
    setBusy("pay");
    setMsg(null);
    try {
      if (chainId !== BASE.id) await switchChainAsync({ chainId: BASE.id });
      const pub = getPublicClient(config, { chainId: BASE.id })!;
      const wallet = await getWalletClient(config, { chainId: BASE.id });
      const { request } = await pub.simulateContract({ address: TWIG_ADDRESS, abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [DEAD, BigInt(q.amount)], account: address, dataSuffix: BUILDER_DATA_SUFFIX });
      const hash = await wallet.writeContract(request);
      remember(hash);
      try {
        const rc = await pub.waitForTransactionReceipt({ hash });
        if (rc.status !== "success") {
          remember(null); // reverted: nothing was sent, so nothing guards against sending it again
          throw new Error("The transfer reverted on-chain. No TWIG was sent; you can try again.");
        }
      } catch (e) {
        // sent, outcome unknown: say so, never offer to send the same TWIG again
        setMsg({ ok: false, text: e instanceof Error && /reverted/.test(e.message) ? e.message : "Sent. Its confirmation is not in yet: this page updates when it is indexed." });
        return;
      }
      await fetch(`/api/launch/sync?chain=${FEE_CHAIN}&tx=${hash}`, { method: "POST" }).catch(() => {});
      setMsg({ ok: true, text: "Sent. It counts once indexed (seconds)." });
      await reload();
      void bal.refetch();
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  const q = app.quote;
  const left = q ? Math.max(0, Math.floor((Date.parse(q.until) - now) / 1000)) : 0;
  const indexed = sent !== null && app.burns.some((b) => b.tx_hash === sent.toLowerCase());
  const waiting = sent !== null && !indexed && app.status === "open";
  const short = q && bal.data !== undefined && (bal.data as bigint) < BigInt(q.amount);
  const due = Math.max(0, app.fee_usd - app.paid_usd);
  return (
    <div className="space-y-5">
      <div className={`${card} space-y-2 p-5 text-sm`}>
        <p className="font-semibold text-ink">{statusLine(app)}</p>
        {app.reason ? <p className="text-body">Reviewer: {app.reason}</p> : null}
        {app.status === "approved" ? <Link href={pairPath(app.chain, app.address)} className="font-semibold text-brand hover:text-ink">See the pair →</Link> : null}
        {app.can_ask_again ? (
          mine ? <button type="button" onClick={() => void sign("again", {})} disabled={busy !== null} className={btn.secondarySm}>Ask for another review ({app.reviews_max - app.reviews_used} left)</button> : <p className={helper}>The applicant can ask for another review ({app.reviews_max - app.reviews_used} left).</p>
        ) : null}
        <p className={helper}>
          <a href={explorerAddress(app.chain, app.address)} target="_blank" rel="noopener noreferrer" className="underline decoration-line underline-offset-2">{app.symbol} on {CHAIN_LABELS[app.chain]} ↗</a> · Applied by {shortAddr(app.applicant)} · {app.reviews_used} of {app.reviews_max} reviews used.
        </p>
      </div>

      <div className={`${card} space-y-3 p-5`}>
        <h2 className="text-sm font-semibold text-ink">1 · Proof from the community</h2>
        <p className="text-sm text-body">{PAIR_APPLY_COPY.proofAsk}</p>
        <p className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs text-ink">{proofPostText(app.code, app.symbol)}</p>
        <a href={intentUrl(proofPostText(app.code, app.symbol), {})} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-brand hover:text-ink">Post it on X ↗</a>
        {app.proof_url ? <p className="text-sm text-body">Saved: <a href={app.proof_url} target="_blank" rel="noopener noreferrer" className="underline decoration-line underline-offset-2">{app.proof_url}</a></p> : null}
        {mine && app.status !== "approved" && app.status !== "rejected" && app.status !== "expired" ? (
          <div className="flex flex-wrap gap-2">
            <input value={proof} onChange={(e) => setProof(e.target.value)} placeholder="https://x.com/<community>/status/…" aria-label="Proof post link" className={`${input} h-10 min-w-0 flex-1 text-sm`} />
            <button type="button" onClick={() => { const url = proofPostUrl(proof); if (url) void sign("proof", { proof: url }); else setMsg({ ok: false, text: "That is not a link to a post on X." }); }} disabled={busy !== null || !proof.trim()} className={btn.secondarySm}>Save</button>
          </div>
        ) : null}
      </div>

      <div className={`${card} space-y-3 p-5`}>
        <h2 className="text-sm font-semibold text-ink">2 · The fee: ${app.fee_usd} in TWIG</h2>
        <p className="text-sm text-body">{PAIR_APPLY_COPY.feeRule(app.fee_usd)}</p>
        {app.status === "open" && waiting ? (
          <div className="space-y-2">
            <p className="text-sm text-ink">Sent. Waiting for it to be indexed, usually seconds: this page updates by itself.</p>
            <button type="button" onClick={() => void recheck()} disabled={busy !== null} className={btn.secondarySm}>{busy === "recheck" ? "Checking…" : "Check again"}</button>
          </div>
        ) : app.status === "open" ? (
          !open ? <p className={helper}>{PAIR_APPLY_COPY.disabled}</p> : !q ? (
            <button type="button" onClick={() => void getQuote()} disabled={busy !== null} className={btn.primarySm}>{busy === "quote" ? "Pricing…" : `Get the amount for $${Math.ceil(due)}`}</button>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-ink">
                ${Math.ceil(due)} = <span className="font-mono font-semibold">{group(q.twig)} TWIG</span> <span className="text-muted">· locked for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>
              </p>
              <p className={helper}>{PAIR_APPLY_COPY.lockNote} The last digits of the amount name this application, so the transfer itself records what it paid for.</p>
              {short ? (
                <p className="text-xs text-warm-ink">
                  This wallet holds less TWIG than that. <a href={TWIG_WRAP_URL} target="_blank" rel="noreferrer" className="underline">Get TWIG ↗</a>
                </p>
              ) : null}
              <p className="text-xs text-warm-ink">{PAIR_APPLY_COPY.sentFinal}</p>
              <button type="button" onClick={() => void pay()} disabled={!address || busy !== null || left === 0 || Boolean(short)} className={btn.primary}>{!address ? "Connect a wallet to pay" : busy === "pay" ? "Sending…" : `Send ${group(q.twig)} TWIG to 0x…dEaD`}</button>
            </div>
          )
        ) : (
          app.status === "approved" && app.paid_usd < app.fee_usd * 0.98 ? <p className="text-sm text-up">{app.paid_usd > 0 ? PAIR_APPLY_COPY.waivedRest(app.paid_usd) : PAIR_APPLY_COPY.waived}</p> : <p className="text-sm text-up">Paid: ${app.paid_usd.toFixed(2)} of ${app.fee_usd}.</p>
        )}
        {sent ? <p className={helper}><a href={explorerTx(FEE_CHAIN, sent)} target="_blank" rel="noopener noreferrer" className="underline">Your transfer ↗</a></p> : null}
        {app.burns.length ? (
          <ul className="space-y-1 text-xs text-body">
            {app.burns.map((b) => (
              <li key={b.tx_hash}>
                <a href={explorerTx(FEE_CHAIN, b.tx_hash)} target="_blank" rel="noopener noreferrer" className="underline decoration-line underline-offset-2">{group(b.twig)} TWIG</a> · {b.usd !== null ? `$${b.usd.toFixed(2)} (${b.priced_by === "quote" ? "at the locked price" : "at the price when it landed"})` : "not valued yet"} · from {shortAddr(b.sender)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className={`${card} space-y-3 p-5`}>
        <h2 className="text-sm font-semibold text-ink">3 · The check, as it stood when you applied</h2>
        <PrecheckReport p={app.precheck} />
        <p className={helper}>{PAIR_APPLY_COPY.reviewNote}</p>
      </div>
      {msg ? <p role="status" className={`text-sm ${msg.ok ? "text-up" : "text-down-ink"}`}>{msg.text}</p> : null}
    </div>
  );
}

function statusLine(a: PairApplicationPublic): string {
  if (a.status === "open") return `Application ${a.code}: waiting for the fee.`;
  if (a.status === "paid") return `Application ${a.code}: paid, waiting for review.`;
  if (a.status === "changes") return `Application ${a.code}: the reviewer asked for changes.`;
  if (a.status === "approved") return `Application ${a.code}: approved. ${a.symbol} is a community pair.`;
  if (a.status === "expired") return `Application ${a.code}: closed. Anyone may apply for ${a.symbol} again.`;
  return `Application ${a.code}: not listed.`;
}
