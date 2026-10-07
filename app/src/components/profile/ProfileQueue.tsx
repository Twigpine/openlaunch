"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useConfig } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { btn, card } from "@/components/ui";
import { buildProfileModMessage, type ProfileModAction } from "@/lib/profiles/auth";
import type { ReviewRow } from "@/lib/profiles/server";
import { shortAddr } from "@/lib/chainPublic";
import { nowMs } from "@/lib/launchpad/time";
import { friendlyError } from "@/lib/errors";

function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Profiles for an admin: X posts waiting for a person (X did not answer when they were submitted) and the newest
 * profiles, with hide / keep-off-points / reset-name. Every action is an admin-wallet signature.
 */
export default function ProfileQueue() {
  const { address } = useHydratedAccount();
  const config = useConfig();
  const [data, setData] = useState<{ pending: ReviewRow[]; recent: ReviewRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!address) return;
    const res = await fetch(`/api/profile/admin?wallet=${address}`, { cache: "no-store" });
    const d = (await res.json()) as { pending?: ReviewRow[]; recent?: ReviewRow[]; error?: string };
    if (!res.ok) return setErr(d.error ?? "not allowed");
    setErr(null);
    setData({ pending: d.pending ?? [], recent: d.recent ?? [] });
  }, [address]);
  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  async function act(target: string, action: ProfileModAction) {
    if (!address) return;
    try {
      const reason = "";
      const n = nonce();
      const ts = nowMs();
      const wallet = await getWalletClient(config);
      const signature = await wallet.signMessage({ message: buildProfileModMessage({ action, target, wallet: address, nonce: n, ts, reason }) });
      const res = await fetch("/api/profile/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, target, reason, wallet: address, nonce: n, ts, signature }) });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "failed");
      await load();
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  if (!address || err === "not an admin") return null;
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
      {pending && p.x_handle && p.x_post_id ? (
        <p className="text-sm">
          Claims <strong>@{p.x_handle}</strong> ·{" "}
          <a href={`https://x.com/${p.x_handle}/status/${p.x_post_id}`} target="_blank" rel="noopener noreferrer" className="text-brand underline underline-offset-4">open the post</a>{" "}
          (check the author and that the post contains a code starting OL-)
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {pending ? (
          <>
            <button type="button" className={btn.primarySm} onClick={() => void act(p.wallet, "approve_x")}>Approve ✓</button>
            <button type="button" className={btn.secondarySm} onClick={() => void act(p.wallet, "reject_x")}>Reject</button>
          </>
        ) : null}
        <button type="button" className={btn.secondarySm} onClick={() => void act(p.wallet, p.hidden ? "unhide" : "hide")}>{p.hidden ? "Unhide" : "Hide"}</button>
        <button type="button" className={btn.secondarySm} onClick={() => void act(p.wallet, p.points_flag ? "include_points" : "exclude_points")}>{p.points_flag ? "Allow points" : "Keep off points"}</button>
        <button type="button" className={btn.secondarySm} onClick={() => void act(p.wallet, "reset_username")}>Reset username</button>
      </div>
    </div>
  );
  return (
    <section className="space-y-3" aria-labelledby="profile-queue">
      <h2 id="profile-queue" className="text-lg font-semibold text-ink">Profiles</h2>
      {err ? <p className={`${card} p-4 text-sm text-down-ink`}>{err}</p> : null}
      <h3 className="text-sm font-medium text-body">X posts waiting for a person</h3>
      {data?.pending.length === 0 ? <p className={`${card} p-4 text-sm text-muted`}>None.</p> : data?.pending.map((p) => row(p, true))}
      <h3 className="pt-2 text-sm font-medium text-body">Newest profiles</h3>
      {data?.recent.map((p) => row(p, false))}
    </section>
  );
}
