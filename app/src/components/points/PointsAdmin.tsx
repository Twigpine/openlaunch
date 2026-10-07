"use client";

import { useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { btn, card } from "@/components/ui";
import { buildPointsAdminMessage, type PointsAdminAction } from "@/lib/points/auth";
import type { NameEntry } from "@/lib/profiles/server";
import { CHAINS, DEFAULT_CHAIN, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { nowMs } from "@/lib/launchpad/time";
import { friendlyError } from "@/lib/errors";

type Row = { rank: number; wallet: string; points: number; eligible: boolean; why: string };
type Preview = { season: { name: string; starts_at: string; ends_at: string; public: boolean; published_at: string | null } | null; creator?: Row[]; scout?: Row[]; names?: Record<string, NameEntry>; computed_at?: string | null; wallets?: number; eligible?: number; at: number };

function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Season controls for an admin: start a season (not public), see the shadow boards (eligible or not, with why), publish
 * when the trial week looks right, recompute now, end early. Every action is an admin signature.
 */
export default function PointsAdmin() {
  const { address } = useHydratedAccount();
  const { chainId } = useAccount();
  const config = useConfig();
  const chain: ChainKey = (Object.keys(CHAINS) as ChainKey[]).find((k) => CHAINS[k].id === chainId) ?? DEFAULT_CHAIN;
  const [data, setData] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(action: PointsAdminAction, extra: Record<string, unknown> = {}) {
    if (!address) return null;
    const n = nonce();
    const ts = nowMs();
    const wallet = await getWalletClient(config);
    const signature = await wallet.signMessage({ message: buildPointsAdminMessage({ action, wallet: address, nonce: n, ts }) });
    const res = await fetch("/api/points/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, chain, wallet: address, nonce: n, ts, signature, ...extra }) });
    const d = (await res.json()) as Record<string, unknown> & { error?: string };
    if (!res.ok) throw new Error(d.error ?? "failed");
    return d;
  }
  async function run(action: PointsAdminAction, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setErr(null);
    try {
      if (action !== "preview") await call(action, extra);
      setData({ ...((await call("preview")) as Omit<Preview, "at">), at: Date.now() });
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!address) return null;
  const s = data?.season ?? null;
  const running = Boolean(s && data && new Date(s.ends_at).getTime() > data.at);
  const list = (title: string, rows: Row[] | undefined) => (
    <div className={`${card} overflow-hidden`}>
      <h4 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">{title}</h4>
      {rows?.length ? (
        <ol className="divide-y divide-line text-sm">
          {rows.map((r) => (
            <li key={r.wallet} className="flex items-center gap-3 px-4 py-2">
              <span className="w-6 text-right font-mono text-xs text-muted">{r.rank}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium text-ink">{data?.names?.[r.wallet]?.u ?? shortAddr(r.wallet)}</span>
                {r.eligible ? <span className="ml-2 rounded bg-up-soft px-1.5 py-0.5 text-[10px] font-semibold text-up">eligible</span> : <span className="ml-2 rounded bg-paper px-1.5 py-0.5 text-[10px] text-muted">not eligible</span>}
                <span className="block truncate text-xs text-muted">{r.why} · <span className="font-mono">{r.wallet}</span></span>
              </span>
              <span className="font-mono font-bold tnum">{r.points.toLocaleString("en-US")}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-4 py-4 text-sm text-muted">Nothing yet.</p>
      )}
    </div>
  );
  return (
    <section className="space-y-3" aria-labelledby="points-admin">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="points-admin" className="text-lg font-semibold text-ink">Season points</h2>
        <button type="button" disabled={busy} className={btn.secondarySm} onClick={() => void run("preview")}>{data ? "Reload" : "Load"} (signature)</button>
      </div>
      {err ? <p className={`${card} p-4 text-sm text-down-ink`}>{err}</p> : null}
      {data ? (
        <>
          <div className={`${card} space-y-3 p-4 text-sm`}>
            {s ? (
              <p className="text-body">
                <strong className="text-ink">{s.name}</strong> · {new Date(s.starts_at).toUTCString().slice(5, 22)} → {new Date(s.ends_at).toUTCString().slice(5, 22)} UTC ·{" "}
                {s.public ? <span className="font-semibold text-up">public</span> : <span className="font-semibold text-warm-ink">shadow (admins only)</span>} · {data.wallets ?? 0} wallets with points, {data.eligible ?? 0} eligible · computed {data.computed_at ? new Date(data.computed_at).toLocaleTimeString() : "not yet"}
              </p>
            ) : (
              <p className="text-body">No season yet. Starting one begins the shadow run: points are computed hourly but only admins see them. Publishing then starts the season for everyone, with a fresh 28-day clock (the shadow run&apos;s points are only for tuning).</p>
            )}
            <div className="flex flex-wrap gap-2">
              {!running ? <button type="button" disabled={busy} className={btn.primarySm} onClick={() => void run("start", { days: 28 })}>Start a 28-day season</button> : null}
              {s && !s.public ? <button type="button" disabled={busy} className={!s.published_at && running ? btn.primarySm : btn.secondarySm} onClick={() => void run("publish")}>{!s.published_at && running ? `Publish: ${s.name} starts now` : "Show boards"}</button> : null}
              {s && s.public ? <button type="button" disabled={busy} className={btn.secondarySm} onClick={() => void run("unpublish")}>Hide boards</button> : null}
              {s ? <button type="button" disabled={busy} className={btn.secondarySm} onClick={() => void run("recompute")}>Recompute now</button> : null}
              {running ? <button type="button" disabled={busy} className={btn.secondarySm} onClick={() => void run("end")}>End season now</button> : null}
            </div>
          </div>
          {s ? <div className="grid gap-3 md:grid-cols-2">{list("Creators (top 50, eligible or not)", data.creator)}{list("Scouts (top 50, eligible or not)", data.scout)}</div> : null}
        </>
      ) : null}
    </section>
  );
}
