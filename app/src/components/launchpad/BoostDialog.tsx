"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useConfig, useReadContract, useSwitchChain } from "wagmi";
import { getPublicClient, getWalletClient } from "wagmi/actions";
import type { Hex } from "viem";
import { ArrowUpRight } from "lucide-react";
import Sheet from "@/components/Sheet";
import ConnectWallet from "@/components/ConnectWallet";
import { btn } from "@/components/ui";
import { Spinner } from "@/components/Skeleton";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { ERC20_MIN_ABI, ERC20_TRANSFER_ABI } from "@/lib/launchpad/abi";
import { DEAD } from "@/lib/launchpad/config";
import { TWIG_WRAP_URL } from "@/lib/launchpad/twig";
import { fmtUsd } from "@/lib/launchpad/math";
import { friendlyError } from "@/lib/errors";
import { BUILDER_DATA_SUFFIX, CHAINS, explorerTx } from "@/lib/chainPublic";
import {
  BOOST_CHAIN,
  BOOST_COPY,
  BOOST_FLOOR_TWIG,
  BOOST_PRESETS,
  BOOST_TOKEN,
  boostAmount,
  boostAmountProblem,
  boostConfirmLabel,
  boostShowsNow,
  fmtBoostTwig,
  type LaneEntry,
  groupWhole,
  isLaunchTag,
  maxBoostWhole,
  parseBoostWhole,
} from "@/lib/launchpad/boost";
import { toast } from "./TxToasts";
import { TwigMark } from "./TwigBadge";

/** A boost the wallet has sent whose outcome is not known yet; the panel keeps it while the dialog is closed. */
export type PendingBoost = { hash: Hex; whole: bigint };
type Phase =
  | { k: "idle" }
  | { k: "preparing" }
  | { k: "signing" }
  | { k: "sent"; hash: Hex; whole: bigint }
  | { k: "unconfirmed"; hash: Hex; whole: bigint; checking: boolean; note: string | null }
  | { k: "done"; hash: Hex; whole: bigint; shows: boolean }
  | { k: "error"; message: string };

const BASE = CHAINS[BOOST_CHAIN];

/**
 * Send TWIG to 0x…dEaD for a token's place in the Boosted lane (boost.ts): one plain TWIG.transfer whose amount ends in
 * the launch's position id. No approval, nothing to sign but the transfer. Whole TWIG only; the floor and the balance
 * (tag included) are checked before the button wakes, and the transfer is simulated before the wallet is asked.
 * Sent means sent: once the wallet returns a hash, only a receipt ends the action. A receipt that cannot be read leaves
 * it unconfirmed and locked, with "Check again", so a slow node never invites a second burn; the panel holds the hash
 * (`pending`) so closing and reopening the dialog keeps the lock.
 */
export default function BoostDialog({ token, tokenId, symbol, name, twigUsd, current, entry, place, pending, onPending, onClose, onBoosted }: { token: string; tokenId: number; symbol: string; name: string; twigUsd: number | null; current: bigint; entry: LaneEntry; place: number | null; pending: PendingBoost | null; onPending: (p: PendingBoost | null) => void; onClose: () => void; onBoosted?: () => void }) {
  const config = useConfig();
  const { address, isConnected, chainId } = useHydratedAccount();
  const { switchChainAsync } = useSwitchChain();
  const [amount, setAmount] = useState(groupWhole(BOOST_FLOOR_TWIG));
  const [phase, setPhase] = useState<Phase>(pending ? { k: "unconfirmed", ...pending, checking: false, note: null } : { k: "idle" });
  const lock = useRef(false);
  const tag = BigInt(tokenId);
  const tagOk = isLaunchTag(tag);

  const bal = useReadContract({ address: BOOST_TOKEN as `0x${string}`, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: address ? [address] : undefined, chainId: BASE.id, query: { enabled: Boolean(address), refetchInterval: 15_000 } });
  const balance = bal.data as bigint | undefined;
  const whole = parseBoostWhole(amount);
  const problem = tagOk ? boostAmountProblem(whole, balance, tag) : "This launch cannot be boosted.";
  const raw = useMemo(() => (whole !== null && problem === null ? boostAmount(whole, tag) : null), [whole, problem, tag]);
  const max = balance !== undefined && tagOk ? maxBoostWhole(balance, tag) : null;
  const busy = phase.k === "preparing" || phase.k === "signing" || phase.k === "sent" || phase.k === "unconfirmed";
  const usd = whole !== null && twigUsd ? fmtUsd(Number(whole) * twigUsd) : null;
  // a full lane shows 5 tokens: say before the send whether this amount gets this one in, and what would
  const inLane = place !== null;
  const shows = raw === null || boostShowsNow(entry, current, raw, inLane);
  /** Whether a sent boost of `w` whole TWIG brings the token into the lane: one rule for the done screen, however the receipt arrived. */
  const showsAfter = (w: bigint): boolean => !tagOk || boostShowsNow(entry, current, boostAmount(w, tag), inLane);
  const neededWhole = !inLane && entry.full && entry.cutoff !== null ? (() => {
    const gap = BigInt(entry.cutoff) - current;
    return gap > 0n ? (gap + 10n ** 18n - 1n) / 10n ** 18n : 0n;
  })() : null;

  async function send() {
    if (!address || raw === null || whole === null || busy || lock.current) return;
    lock.current = true; // before the first await
    setPhase({ k: "preparing" });
    try {
      if (chainId !== BASE.id) await switchChainAsync({ chainId: BASE.id });
      const pub = getPublicClient(config, { chainId: BASE.id })!;
      const wallet = await getWalletClient(config, { chainId: BASE.id });
      const { request } = await pub.simulateContract({ address: BOOST_TOKEN as `0x${string}`, abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [DEAD, raw], account: address, dataSuffix: BUILDER_DATA_SUFFIX });
      setPhase({ k: "signing" });
      const hash = await wallet.writeContract(request);
      onPending({ hash, whole });
      setPhase({ k: "sent", hash, whole });
      let rc;
      try {
        rc = await pub.waitForTransactionReceipt({ hash });
      } catch {
        // sent, outcome unknown: never an error that would let the same TWIG be sent twice
        setPhase({ k: "unconfirmed", hash, whole, checking: false, note: null });
        return;
      }
      await settle(hash, whole, rc.status === "success", showsAfter(whole));
    } catch (err) {
      setPhase({ k: "error", message: friendlyError(err) });
    } finally {
      lock.current = false;
    }
  }

  /** A final answer for a sent boost: indexed and done, or reverted (sending again is then safe). */
  async function settle(hash: Hex, whole: bigint, ok: boolean, shows: boolean) {
    onPending(null);
    if (!ok) {
      setPhase({ k: "error", message: "The transfer reverted on-chain. No TWIG was sent; you can try again." });
      return;
    }
    // index it now rather than at the next poll: the lane and this page show it straight away
    await fetch(`/api/launch/sync?chain=${BOOST_CHAIN}&tx=${hash}`, { method: "POST" }).catch(() => {});
    setPhase({ k: "done", hash, whole, shows });
    toast({ kind: "info", title: `${symbol} is boosted`, sub: `${groupWhole(whole)} TWIG sent to 0x…dEaD`, chain: BOOST_CHAIN, token, symbol });
    void bal.refetch();
    onBoosted?.();
  }

  async function checkAgain() {
    if (phase.k !== "unconfirmed" || phase.checking) return;
    const { hash, whole } = phase;
    setPhase({ ...phase, checking: true, note: null });
    try {
      const rc = await getPublicClient(config, { chainId: BASE.id })!.getTransactionReceipt({ hash });
      await settle(hash, whole, rc.status === "success", showsAfter(whole));
    } catch {
      setPhase({ k: "unconfirmed", hash, whole, checking: false, note: "Not confirmed yet. Check your wallet's activity before sending anything again." });
    }
  }

  return (
    <Sheet title={`Boost ${symbol}`} onClose={onClose}>
      {phase.k === "done" ? (
        <div className="space-y-4">
          <p className="text-sm text-ink">{place !== null ? `${name} is #${place} in the Boosted lane.` : phase.shows ? `${name} is in the Boosted lane.` : `${name} is not in the lane yet: the 5th place still holds more.`}</p>
          <p className="text-xs leading-relaxed text-muted">{fmtBoostTwig(boostAmount(phase.whole, tag))} went to 0x…dEaD. It counts for the next 24 hours and adds up with any other boost on {symbol}; the lane shows the 5 largest totals.</p>
          <div className="flex flex-wrap gap-2">
            <a href={explorerTx(BOOST_CHAIN, phase.hash)} target="_blank" rel="noreferrer" className={btn.secondarySm}>View transaction<ArrowUpRight size={13} aria-hidden="true" /></a>
            <Link href="/#boosted" onClick={onClose} className={btn.secondarySm}>See the lane</Link>
            <button type="button" onClick={onClose} className={btn.primarySm}>Done</button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-pretty text-xs leading-relaxed text-body">{BOOST_COPY.what}</p>

          <div className="rounded-2xl border border-line bg-paper px-4 pb-3.5 pt-3 has-[input:focus-visible]:border-transparent has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-brand/60">
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
              <label htmlFor={`boost-${token}`}>You send</label>
              {balance !== undefined ? (
                <button type="button" disabled={busy || max === null || max < BOOST_FLOOR_TWIG} onClick={() => max !== null && setAmount(groupWhole(max))} className="-mr-1.5 truncate rounded-md px-1.5 py-0.5 font-mono text-[10px] hover:bg-ink/5 hover:text-ink disabled:cursor-default disabled:hover:bg-transparent" title="Use the most this wallet can send">
                  Balance {fmtBoostTwig(balance)}{max !== null && max >= BOOST_FLOOR_TWIG ? " · Max" : ""}
                </button>
              ) : null}
            </div>
            <div className="mt-1.5 flex items-center gap-3">
              <input
                id={`boost-${token}`}
                inputMode="numeric"
                autoComplete="off"
                disabled={busy}
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d,]/g, "").slice(0, 16))}
                className="w-full min-w-0 bg-transparent py-1 font-mono text-[28px] leading-tight text-ink placeholder:text-faint focus-visible:outline-none! tnum"
                placeholder={groupWhole(BOOST_FLOOR_TWIG)}
                aria-describedby={`boost-${token}-note`}
              />
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink"><TwigMark size={14} className="rounded-[3px]" />TWIG</span>
            </div>
            <div className="mt-3 flex gap-1.5">
              {BOOST_PRESETS.map((p) => (
                <button key={p} type="button" disabled={busy} onClick={() => setAmount(groupWhole(BigInt(p)))} aria-label={`Send ${groupWhole(BigInt(p))} TWIG`} className="min-h-7 flex-1 rounded-full border border-line px-2 font-mono text-[11px] tnum hover:border-line-strong hover:text-ink">
                  {fmtBoostTwig(BigInt(p) * 10n ** 18n).replace(" TWIG", "")}
                </button>
              ))}
            </div>
            <p id={`boost-${token}-note`} className="mt-2 min-h-4 text-[10px] text-muted">{problem ?? (usd ? `≈ ${usd} at today's TWIG price` : " ")}</p>
          </div>

          {/* the lane is full and this amount stays under its 5th place: said before anything is sent */}
          {problem === null && !shows ? (
            <div role="note" className="space-y-1.5 rounded-xl border border-line bg-paper px-3 py-2.5 text-pretty text-[11px] leading-relaxed text-body">
              <p>{BOOST_COPY.short}</p>
              {neededWhole !== null && neededWhole > 0n ? (
                <button type="button" disabled={busy} onClick={() => setAmount(groupWhole(neededWhole < BOOST_FLOOR_TWIG ? BOOST_FLOOR_TWIG : neededWhole))} className="font-medium text-ink underline underline-offset-2 hover:text-brand">
                  Send {groupWhole(neededWhole < BOOST_FLOOR_TWIG ? BOOST_FLOOR_TWIG : neededWhole)} TWIG to show now
                </button>
              ) : null}
            </div>
          ) : null}

          <dl className="space-y-2 px-1 text-[11px]">
            <div className="flex justify-between gap-3"><dt className="text-muted">Goes to</dt><dd className="text-right font-mono text-body">0x…dEaD (burned)</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Lasts</dt><dd className="text-right text-body">24 hours from this boost</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Platform fee</dt><dd className="text-right font-mono text-up tnum">$0</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Amount ends in</dt><dd className="text-right font-mono text-body tnum" title={BOOST_COPY.tag}>…{tokenId}</dd></div>
          </dl>
          <p className="text-pretty text-[11px] leading-relaxed text-muted">{BOOST_COPY.tag}</p>
          <p role="note" className="rounded-xl border border-warm/30 bg-warm-soft px-3 py-2 text-pretty text-[11px] leading-relaxed text-warm-ink">{BOOST_COPY.final}</p>

          {balance === 0n ? (
            <p className="text-[11px] text-muted">
              No TWIG in this wallet. Wrap GITLAWB 1:1 or buy TWIG at{" "}
              <a href={TWIG_WRAP_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">wrap.twigpine.com ↗</a>
            </p>
          ) : null}

          {!isConnected ? (
            <ConnectWallet className={`${btn.secondary} w-full !border-ink !bg-ink !text-inverse`}>Connect a wallet to boost</ConnectWallet>
          ) : (
            <button type="button" disabled={busy || raw === null} onClick={() => void send()} className={`${btn.primary} w-full`}>
              {phase.k === "preparing" ? <><Spinner size={14} /> Preparing…</> : phase.k === "signing" ? <><Spinner size={14} /> Confirm in your wallet…</> : phase.k === "sent" ? <><Spinner size={14} /> Waiting for Base…</> : phase.k === "unconfirmed" ? "Waiting for confirmation" : whole !== null && problem === null ? boostConfirmLabel(whole) : "Boost"}
            </button>
          )}
          {phase.k === "sent" ? <a href={explorerTx(BOOST_CHAIN, phase.hash)} target="_blank" rel="noreferrer" className="block text-center text-[11px] text-muted underline underline-offset-2 hover:text-ink">View the transaction ↗</a> : null}
          {phase.k === "unconfirmed" ? (
            <div role="status" className="space-y-2 rounded-xl border border-line bg-paper px-3 py-2.5 text-[11px] leading-relaxed text-body">
              <p>Your wallet sent {groupWhole(phase.whole)} TWIG, but Base has not confirmed it to this page yet. Sending is locked until it does, so the same boost is never paid twice.</p>
              {phase.note ? <p className="text-warm-ink">{phase.note}</p> : null}
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" disabled={phase.checking} onClick={() => void checkAgain()} className={btn.secondarySm}>{phase.checking ? <><Spinner size={12} /> Checking…</> : "Check again"}</button>
                <a href={explorerTx(BOOST_CHAIN, phase.hash)} target="_blank" rel="noreferrer" className="text-muted underline underline-offset-2 hover:text-ink">View the transaction ↗</a>
              </div>
            </div>
          ) : null}
          {phase.k === "error" ? <p role="alert" className="text-pretty text-[11px] leading-relaxed text-down-ink">{phase.message}</p> : null}
        </div>
      )}
    </Sheet>
  );
}
