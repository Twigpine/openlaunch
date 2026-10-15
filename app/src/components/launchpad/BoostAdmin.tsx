"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useConfig } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { isAddress } from "viem";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { btn, card } from "@/components/ui";
import type { BoostLane } from "@/lib/launchpad/boostServer";
import { BOOST_CHAIN, buildBoostModMessage, fmtBoostTwig, type BoostModAction } from "@/lib/launchpad/boost";
import { CHAINS } from "@/lib/chainPublic";
import { nowMs } from "@/lib/launchpad/time";
import { friendlyError } from "@/lib/errors";
import { nonce } from "@/lib/nonce";

/**
 * The Boosted lane for moderators: what is in it now, Hide on each card, and Hide / Unhide by address (a hidden token is
 * no longer listed anywhere, so showing it again takes its address). Each action is an admin-wallet signature. Hiding
 * never refunds: the TWIG was burned on-chain.
 */
export default function BoostAdmin() {
  const { address } = useHydratedAccount();
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
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `request failed (HTTP ${res.status})`);
      setMsg({ ok: true, text: `${action === "hide" ? "Hidden" : "Shown again"}: ${token}` });
      // a hidden card leaves the list at once; the next read (fresh on the machine that took the write) confirms it
      if (action === "hide") setLane((l) => (l?.enabled ? { ...l, items: l.items.filter((b) => b.token !== token.toLowerCase()) } : l));
      await load();
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
    </section>
  );
}
