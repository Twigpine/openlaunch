"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { btn, card } from "@/components/ui";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { shortAddr } from "@/lib/chainPublic";
import { friendlyError } from "@/lib/errors";
import type { AdminSessionRow } from "@/lib/admin/session";

const time = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Who is signed in to the admin and until when, Sign out, and this wallet's sessions (each can be ended, or all at
 * once). When the session runs out the page loads again, back to the sign-in card. A connected wallet other than the
 * signed-in one is called out: the panels act only from the signed-in wallet.
 */
export default function AdminSessionBar({ wallet, expiresAt, id }: { wallet: string; expiresAt: string; id: number }) {
  const router = useRouter();
  const { address } = useHydratedAccount();
  const [sessions, setSessions] = useState<AdminSessionRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => router.refresh(), Math.max(0, new Date(expiresAt).getTime() - Date.now()) + 1_000);
    return () => clearTimeout(t);
  }, [expiresAt, router]);

  async function loadSessions() {
    try {
      const res = await fetch("/api/admin/session", { cache: "no-store" });
      const d = (await res.json().catch(() => ({}))) as { admin?: unknown; sessions?: AdminSessionRow[]; error?: string };
      if (!res.ok) throw new Error(d.error ?? `request failed (HTTP ${res.status})`);
      if (!d.admin) return router.refresh();
      setSessions(d.sessions ?? []);
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  async function end(query: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/session${query}`, { method: "DELETE" });
      const d = (await res.json().catch(() => ({}))) as { signedOut?: boolean; error?: string };
      if (!res.ok && res.status !== 401) throw new Error(d.error ?? `request failed (HTTP ${res.status})`);
      if (res.status === 401 || d.signedOut) return router.refresh();
      await loadSessions();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  const other = address && address.toLowerCase() !== wallet;
  return (
    <section className={`${card} space-y-3 p-4 text-sm`} aria-label="Admin session">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-body">
          Signed in as <span className="font-mono text-ink">{shortAddr(wallet)}</span> until <time dateTime={expiresAt} suppressHydrationWarning>{time(expiresAt)}</time>
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn.secondarySm} aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void loadSessions(); }}>Sessions</button>
          <button type="button" disabled={busy} className={btn.secondarySm} onClick={() => void end("")}>Sign out</button>
        </div>
      </div>
      {!address ? <p className="text-xs text-warm-ink">Connect {shortAddr(wallet)} to act: every action is also a signature from it.</p> : null}
      {other ? <p role="alert" className="text-xs text-down-ink">The connected wallet {shortAddr(address)} is not the signed-in admin. Switch to {shortAddr(wallet)} to act.</p> : null}
      {open ? (
        <div className="space-y-2 border-t border-line pt-3">
          {sessions === null ? <p className="text-xs text-muted">Loading…</p> : null}
          {sessions?.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-body">
                {s.device}
                {s.id === id ? <span className="ml-1.5 rounded bg-up-soft px-1.5 py-0.5 text-[10px] font-semibold text-up">this one</span> : null}
                <span className="block text-muted" suppressHydrationWarning>Signed in {time(s.created_at)} · last seen {time(s.last_seen_at)} · ends {time(s.expires_at)}</span>
              </span>
              <button type="button" disabled={busy} className={`${btn.secondarySm} text-down-ink`} onClick={() => void end(`?id=${s.id}`)}>End</button>
            </div>
          ))}
          {sessions?.length ? <button type="button" disabled={busy} className={`${btn.secondarySm} text-down-ink`} onClick={() => void end("?all=1")}>Sign out everywhere</button> : null}
        </div>
      ) : null}
      {err ? <p role="alert" className="text-xs text-down-ink">{err}</p> : null}
    </section>
  );
}
