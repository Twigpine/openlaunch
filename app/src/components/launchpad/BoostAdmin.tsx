"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useConfig } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { isAddress } from "viem";
import { useAdminAccount } from "@/components/admin/AdminAccount";
import { btn, card } from "@/components/ui";
import type { BoostLane, BoostStats } from "@/lib/launchpad/boostServer";
import { BOOST_CHAIN, BOOST_STATS_DAYS, boostClickRate, boostClicksPerFloor, buildBoostModMessage, fmtBoostTwig, type BoostModAction, type BoostStatsDays } from "@/lib/launchpad/boost";
import { CHAINS } from "@/lib/chainPublic";
import { nowMs } from "@/lib/launchpad/time";
import { friendlyError } from "@/lib/errors";
import { nonce } from "@/lib/nonce";

/**
 * The Boosted lane for moderators: what is in it now, Hide on each card, and Hide / Unhide by address (a hidden token is
 * no longer listed anywhere, so showing it again takes its address). Each action is an admin-wallet signature. Hiding
 * never refunds: the TWIG was burned on-chain. Below them, the lane's views and clicks per token.
 */
export default function BoostAdmin() {
  const { address } = useAdminAccount();
  const config = useConfig();
  const [lane, setLane] = useState<BoostLane | null>(null);
  const [target, setTarget] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // a failed or unreadable answer (a proxy's HTML page) keeps the last list on screen; it never throws from the effect
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/boost?chain=${BOOST_CHAIN}`, { cache: "no-store" });
      if (res.ok) setLane((await res.json()) as BoostLane);
    } catch {
      // keep the last lane
    }
  }, []);
  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  async function act(token: string, action: BoostModAction) {
    if (!address) return;
    try {
      const n = nonce();
      const ts = nowMs();
      const wallet = await getWalletClient(config, { chainId: CHAINS[BOOST_CHAIN].id });
      const signature = await wallet.signMessage({ message: buildBoostModMessage({ action, token, wallet: address, nonce: n, ts }) });
      const res = await fetch("/api/boost/mod", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, token, wallet: address, nonce: n, ts, signature }) });
      // an error page that is not JSON (a 502 from the proxy) still reports the HTTP failure, not a parse error
      const d = (await res.json().catch(() => ({}))) as { error?: string; lane?: BoostLane | null };
      if (!res.ok) throw new Error(d.error ?? `request failed (HTTP ${res.status})`);
      setMsg({ ok: true, text: `${action === "hide" ? "Hidden" : "Shown again"}: ${token}` });
      // the signed answer carries the lane read fresh, so the list is right at once, whichever machine answers next;
      // without it (that read failed) the card still leaves at once and a cached read follows
      if (d.lane) {
        setLane(d.lane);
      } else {
        if (action === "hide") setLane((l) => (l?.enabled ? { ...l, items: l.items.filter((b) => b.token !== token.toLowerCase()) } : l));
        await load();
      }
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    }
  }

  if (lane && !lane.enabled) return null;
  return (
    <section className="space-y-3" aria-labelledby="boost-admin-heading">
      <h2 id="boost-admin-heading" className="text-lg font-semibold text-ink">Boosted lane</h2>
      {!address ? <p className={`${card} p-6 text-sm text-muted`}>Connect the admin wallet.</p> : null}
      {lane?.enabled && lane.items.length === 0 ? <p className={`${card} p-6 text-sm text-muted`}>Nothing is boosted right now.</p> : null}
      {lane?.enabled
        ? lane.items.map((b) => (
            <div key={b.token} className={`${card} flex flex-wrap items-center justify-between gap-3 p-4`}>
              <div className="min-w-0 text-sm">
                <Link href={`/t/${BOOST_CHAIN}/${b.token}`} className="font-semibold text-ink">{b.launch.name}</Link>
                <span className="ml-2 font-mono text-[11px] text-muted">{fmtBoostTwig(b.twig)} · {b.boosts} {b.boosts === 1 ? "boost" : "boosts"}</span>
              </div>
              <button type="button" disabled={!address} onClick={() => void act(b.token, "hide")} className={`${btn.secondarySm} text-down-ink`}>Hide</button>
            </div>
          ))
        : null}
      <div className={`${card} space-y-2 p-4`}>
        <label htmlFor="boost-admin-token" className="text-[11px] text-muted">A Base token address</label>
        <div className="flex flex-wrap gap-2">
          <input id="boost-admin-token" value={target} onChange={(e) => setTarget(e.target.value.trim())} placeholder="0x…" className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 font-mono text-xs text-ink" />
          <button type="button" disabled={!address || !isAddress(target)} onClick={() => void act(target, "hide")} className={`${btn.secondarySm} text-down-ink`}>Hide</button>
          <button type="button" disabled={!address || !isAddress(target)} onClick={() => void act(target, "unhide")} className={btn.secondarySm}>Unhide</button>
        </div>
      </div>
      {msg ? <p role="status" className={`text-xs ${msg.ok ? "text-up" : "text-down-ink"}`}>{msg.text}</p> : null}
      {address ? <LaneStats wallet={address} /> : null}
    </section>
  );
}

const num = (n: number) => n.toLocaleString("en-US");

/**
 * Views and clicks per token over a period, with the TWIG burned for each: whether a place in the lane brings visitors.
 * A view is a page load that brought the lane on screen; a click counts once per address and 30 minutes, and only
 * while the token was in the lane. Visitors: one per address per day.
 */
function LaneStats({ wallet }: { wallet: string }) {
  const [days, setDays] = useState<BoostStatsDays>(7);
  // both keyed by period: a period still loading shows "Loading…", never the last period's figures or error
  const [got, setGot] = useState<{ key: string; stats: BoostStats } | null>(null);
  const [failed, setFailed] = useState<{ key: string; text: string } | null>(null);
  const key = `${wallet.toLowerCase()}:${days}`;
  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/boost/stats?days=${days}`, { cache: "no-store", signal: ac.signal })
      .then(async (res) => {
        const d = (await res.json().catch(() => ({}))) as Partial<BoostStats> & { error?: string };
        if (!res.ok || !d.rows || !d.total) throw new Error(d.error ?? `request failed (HTTP ${res.status})`);
        setGot({ key, stats: { rows: d.rows, total: d.total } });
      })
      .catch((e) => {
        if (!ac.signal.aborted) setFailed({ key, text: friendlyError(e) });
      });
    return () => ac.abort();
  }, [wallet, days, key]);

  const stats = got?.key === key ? got.stats : null;
  const err = !stats && failed?.key === key ? failed.text : null;
  const rows = stats?.rows ?? null;
  const total = stats?.total;
  const per = (clicks: number, twig: string) => {
    const v = boostClicksPerFloor(clicks, twig);
    return v === null ? "–" : v.toFixed(1);
  };
  return (
    <div className={`${card} space-y-3 p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">Views and clicks</h3>
        <div role="group" aria-label="Period" className="flex gap-1">
          {BOOST_STATS_DAYS.map((d) => (
            <button key={d} type="button" aria-pressed={d === days} onClick={() => setDays(d)} className={`rounded-full px-2.5 py-1 text-[11px] ${d === days ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}>
              {d === 1 ? "24h" : `${d}d`}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-muted">A view is a page that brought the lane on screen. A click counts once per address every 30 minutes, only while the token is in the lane. Visitors: one per address per day, per token. The top {num(100)} tokens are listed; the totals cover all.</p>
      {err ? <p role="status" className="text-xs text-down-ink">{err}</p> : null}
      {rows === null ? (
        err ? null : <p className="text-xs text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted">No views, clicks or boosts in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead className="text-[11px] text-muted">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-medium">Token</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Views</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Clicks</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Rate</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Visitors</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">TWIG burned</th>
                <th scope="col" className="py-1.5 text-right font-medium" title="Clicks for every 100,000 TWIG burned for the token in this period">Per 100K</th>
              </tr>
            </thead>
            <tbody className="font-mono tnum">
              {rows.map((r) => (
                <tr key={r.token} className="border-t border-line">
                  <td className="max-w-[160px] truncate py-1.5 pr-3 font-sans">
                    <Link href={`/t/${BOOST_CHAIN}/${r.token}`} className="font-semibold text-ink hover:underline">{r.symbol ?? r.token.slice(0, 10)}</Link>
                  </td>
                  <td className="py-1.5 pr-3 text-right">{num(r.views)}</td>
                  <td className="py-1.5 pr-3 text-right text-ink">{num(r.clicks)}</td>
                  <td className="py-1.5 pr-3 text-right">{boostClickRate(r.clicks, r.views)}</td>
                  <td className="py-1.5 pr-3 text-right">{num(r.visitors)}</td>
                  <td className="py-1.5 pr-3 text-right">{BigInt(r.twig) > 0n ? fmtBoostTwig(r.twig) : "–"}</td>
                  <td className="py-1.5 text-right">{per(r.clicks, r.twig)}</td>
                </tr>
              ))}
            </tbody>
            {total ? (
              <tfoot className="font-mono tnum text-ink">
                <tr className="border-t border-line-strong">
                  <th scope="row" className="py-1.5 pr-3 text-left font-sans font-medium">{total.tokens > rows.length ? `All ${num(total.tokens)}` : "All"}</th>
                  <td className="py-1.5 pr-3 text-right">{num(total.views)}</td>
                  <td className="py-1.5 pr-3 text-right">{num(total.clicks)}</td>
                  <td className="py-1.5 pr-3 text-right">{boostClickRate(total.clicks, total.views)}</td>
                  {/* a visitor is counted per token: one person on five cards cannot be told from five people */}
                  <td className="py-1.5 pr-3 text-right text-muted" title="Not added up: a visitor is counted per token">–</td>
                  <td className="py-1.5 pr-3 text-right">{BigInt(total.twig) > 0n ? fmtBoostTwig(total.twig) : "–"}</td>
                  <td className="py-1.5 text-right">{per(total.clicks, total.twig)}</td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      )}
    </div>
  );
}
