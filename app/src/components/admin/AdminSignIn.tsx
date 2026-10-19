"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useConfig } from "wagmi";
import { walletOnChain } from "@/lib/walletOnChain";
import ConnectButton from "@/components/ConnectButton";
import { btn, card } from "@/components/ui";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { CHAINS, shortAddr } from "@/lib/chainPublic";
import { friendlyError } from "@/lib/errors";
import { buildAdminSignInMessage } from "@/lib/admin/signIn";

/**
 * The admin page for anyone without an admin session: connect a wallet, sign one Sign-In with Ethereum message, and
 * the page loads again with the panels. Nothing else of the admin reaches the browser before that.
 */
export default function AdminSignIn() {
  const router = useRouter();
  const config = useConfig();
  const { address } = useHydratedAccount();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const checked = useRef(false);

  // the session cookie is SameSite=Strict, so a visit that starts from a link on another site arrives without it:
  // ask from inside the page, where the browser does send it, and load the page again when a session is there
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    fetch("/api/admin/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { admin?: unknown }) => {
        if (d.admin) router.refresh();
      })
      .catch(() => {});
  }, [router]);

  async function signIn() {
    if (!address || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const n = await fetch("/api/admin/nonce", { method: "POST" });
      const nd = (await n.json().catch(() => ({}))) as { nonce?: string; issuedAt?: string; error?: string };
      if (!n.ok || !nd.nonce || !nd.issuedAt) throw new Error(nd.error ?? `request failed (HTTP ${n.status})`);
      const message = buildAdminSignInMessage({ origin: window.location.origin, address, nonce: nd.nonce, issuedAt: new Date(nd.issuedAt) });
      const wallet = await walletOnChain(config, CHAINS.base.id);
      const signature = await wallet.signMessage({ account: address, message });
      const res = await fetch("/api/admin/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `request failed (HTTP ${res.status})`);
      router.refresh();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`${card} space-y-4 p-6`} aria-labelledby="admin-sign-in">
      <div className="space-y-1.5">
        <h1 id="admin-sign-in" className="font-display text-2xl font-bold tracking-[-0.02em] text-ink">Admin sign-in</h1>
        <p className="text-sm text-body">For openlaunch admins. Sign in with an admin wallet: one signature, no transaction, nothing spent. The session lasts 8 hours.</p>
      </div>
      {address ? (
        <button type="button" disabled={busy} onClick={() => void signIn()} className={`${btn.primary} w-full`}>
          {busy ? "Check your wallet…" : `Sign in as ${shortAddr(address)}`}
        </button>
      ) : (
        <ConnectButton block />
      )}
      {err ? <p role="alert" className="text-sm text-down-ink">{err}</p> : null}
    </section>
  );
}
