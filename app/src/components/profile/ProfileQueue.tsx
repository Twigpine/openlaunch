"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { btn, card } from "@/components/ui";
import { buildProfileAdminListMessage, buildProfileModMessage, type ProfileModAction } from "@/lib/profiles/auth";
import type { ReviewRow } from "@/lib/profiles/server";
import { CHAINS, DEFAULT_CHAIN, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { nowMs } from "@/lib/launchpad/time";
import { friendlyError } from "@/lib/errors";
import { nonce } from "@/lib/nonce";

/**
 * Profiles for an admin: X posts waiting for a person (X did not answer when they were submitted), each shown with
 * the exact code that was issued for it, and the newest profiles. Loading the queue and every action is an
 * admin-wallet signature (the queue lists claimed, unverified handles).
 */
export default function ProfileQueue() {
  const { address } = useHydratedAccount();
  const config = useConfig();
  const { chainId } = useAccount();
  // the chain the wallet signs on (a smart-wallet admin is checked there)
  const chain: ChainKey = (Object.keys(CHAINS) as ChainKey[]).find((k) => CHAINS[k].id === chainId) ?? DEFAULT_CHAIN;
  // the queue is read with one admin wallet's signature and shown only while that wallet is connected; a load that
  // finishes after a switch never replaces another wallet's queue
  const me = address?.toLowerCase() ?? "";
  const [loaded, setLoaded] = useState<{ wallet: string; pending: ReviewRow[]; recent: ReviewRow[] } | null>(null);
  const [failed, setFailed] = useState<{ wallet: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const data = loaded?.wallet === me ? loaded : null;
  const err = failed?.wallet === me ? failed.message : null;
  const setErr = (message: string | null) => setFailed(message ? { wallet: me, message } : null);
  const current = useRef(me);
  useEffect(() => {
    current.current = me;
  }, [me]);

  async function signed(message: (n: string, ts: number) => string) {
    const n = nonce();
    const ts = nowMs();
    const wallet = await getWalletClient(config);
    return { nonce: n, ts, signature: await wallet.signMessage({ message: message(n, ts) }) };
  }

  async function load() {
    if (!address) return;
    setBusy(true);
    try {
      const s = await signed((n, ts) => buildProfileAdminListMessage({ wallet: address, nonce: n, ts }));
      const res = await fetch("/api/profile/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "list", chain, wallet: address, ...s }) });
      const d = (await res.json()) as { pending?: ReviewRow[]; recent?: ReviewRow[]; error?: string };
      if (!res.ok) throw new Error(d.error ?? "not allowed");
      setErr(null);
      const who = address.toLowerCase();
      if (current.current === who) setLoaded({ wallet: who, pending: d.pending ?? [], recent: d.recent ?? [] }); // signed by a wallet no longer connected: dropped
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  // approve / reject sign the code shown on the row, so they only ever act on the claim that was looked at
  async function act(target: string, action: ProfileModAction, claim = "") {
    if (!address) return;
    setBusy(true);
    try {
      const reason = "";
      const s = await signed((n, ts) => buildProfileModMessage({ action, target, wallet: address, nonce: n, ts, reason, claim }));
      const res = await fetch("/api/profile/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, target, reason, claim, chain, wallet: address, ...s }) });
      const d = (await res.json()) as { error?: string; row?: ReviewRow | null };
      if (!res.ok) throw new Error(d.error ?? "failed");
      // the answer carries the profile as it is now: patch the queue in place (Reload is the one signed list read)
      const who = address.toLowerCase();
      if (current.current === who) {
        const now = d.row ?? null;
        setLoaded((cur) => {
          if (!cur || cur.wallet !== who) return cur;
          const recent = now ? cur.recent.map((r) => (r.wallet === target ? now : r)) : cur.recent.filter((r) => r.wallet !== target);
          const pending = now && now.x_status === "pending_review" ? cur.pending.map((r) => (r.wallet === target ? { ...r, ...now, code: r.code, post_id: r.post_id } : r)) : cur.pending.filter((r) => r.wallet !== target);
          return { ...cur, recent, pending };
        });
      }
      setBusy(false);
    } catch (e) {
      setErr(friendlyError(e));
      setBusy(false);
    }
  }

  if (!address) return null;
  const row = (p: ReviewRow, pending: boolean) => (
    <div key={`${pending ? "p" : "r"}:${p.wallet}`} className={`${card} space-y-2 p-4`}>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <Link href={`/u/${p.username}`} className="font-sans text-sm font-semibold text-ink">{p.display_name}</Link>
        <span className="font-mono">{p.username}</span>
        <span className="font-mono">{shortAddr(p.wallet)}</span>
        <span>{p.x_status}</span>
        {p.hidden ? <span className="text-down-ink">hidden</span> : null}
        {p.points_flag ? <span className="text-warm-ink">no points</span> : null}
      </div>
      {pending && p.x_handle && p.post_id && p.code ? (
        <div className="space-y-1 text-sm">
          <p>
            Claims <strong>@{p.x_handle}</strong> ·{" "}
            <a href={`https://x.com/${p.x_handle}/status/${p.post_id}`} target="_blank" rel="noopener noreferrer" className="text-brand underline underline-offset-4">open the post</a>
          </p>
          <p className="text-[13px] text-body">
            Approve only if the post is by @{p.x_handle} and contains exactly <code className="rounded bg-paper px-1.5 py-0.5 font-mono text-ink">{p.code}</code>. Any other code means reject.
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {pending && p.code ? (
          <>
            <button type="button" disabled={busy} className={btn.primarySm} onClick={() => void act(p.wallet, "approve_x", p.code ?? "")}>Approve ✓</button>
            <button type="button" disabled={busy} className={btn.secondarySm} onClick={() => void act(p.wallet, "reject_x", p.code ?? "")}>Reject</button>
          </>
        ) : null}
        {!pending && p.x_status !== "none" ? <button type="button" disabled={busy} className={btn.secondarySm} onClick={() => void act(p.wallet, "remove_x")}>Remove ✓</button> : null}
        <button type="button" disabled={busy} className={btn.secondarySm} onClick={() => void act(p.wallet, p.hidden ? "unhide" : "hide")}>{p.hidden ? "Unhide" : "Hide"}</button>
        <button type="button" disabled={busy} className={btn.secondarySm} onClick={() => void act(p.wallet, p.points_flag ? "include_points" : "exclude_points")}>{p.points_flag ? "Allow points" : "Keep off points"}</button>
        <button type="button" disabled={busy} className={btn.secondarySm} onClick={() => void act(p.wallet, "reset_username")}>Retire username</button>
      </div>
    </div>
  );
  return (
    <section className="space-y-3" aria-labelledby="profile-queue">
      <div className="flex items-center justify-between gap-3">
        <h2 id="profile-queue" className="text-lg font-semibold text-ink">Profiles</h2>
        <button type="button" disabled={busy} className={btn.secondarySm} onClick={() => void load()}>{data ? "Reload" : "Load profiles"} (signature)</button>
      </div>
      {err ? <p className={`${card} p-4 text-sm text-down-ink`}>{err}</p> : null}
      {data ? (
        <>
          <h3 className="text-sm font-medium text-body">X posts waiting for a person</h3>
          {data.pending.length === 0 ? <p className={`${card} p-4 text-sm text-muted`}>None.</p> : data.pending.map((p) => row(p, true))}
          <h3 className="pt-2 text-sm font-medium text-body">Newest profiles</h3>
          {data.recent.map((p) => row(p, false))}
        </>
      ) : null}
    </section>
  );
}
