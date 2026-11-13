"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useConfig } from "wagmi";
import { walletOnChain } from "@/lib/walletOnChain";
import { isAddress } from "viem";
import { useAdminAccount } from "@/components/admin/AdminAccount";
import { btn, card } from "@/components/ui";
import { CHAINS, CHAIN_LABELS, type ChainKey } from "@/lib/chainPublic";
import { nowMs } from "@/lib/launchpad/time";
import { friendlyError } from "@/lib/errors";
import { nonce } from "@/lib/nonce";
import { fmtUsd } from "@/lib/launchpad/math";
import { NATIVE, coreQuotes } from "@/lib/launchpad/config";
import { PAIR_CHAINS, PAIR_FEE_CHAIN, PAIR_PRICE_KINDS, PAIR_PRICE_KIND_LABEL, buildPairAdminMessage, pairPath, type PairAdminAction, type PairListing, type PairPriceKind, type PairPublic } from "@/lib/launchpad/pairs";

/** The core quotes a price pool on this chain may trade against: the same list the server checks (config.ts coreQuotes). */
const coreQuoteOptions = (chain: ChainKey) => coreQuotes(chain).map((q) => ({ label: q.address === NATIVE ? `${q.symbol} (native)` : q.symbol, address: q.address.toLowerCase() }));
function emptyDraft(chain: ChainKey) {
  const quotes = coreQuoteOptions(chain);
  return { chain, address: "", logo: "", website: "", x_handle: "", description: "", price_kind: "univ3" as PairPriceKind, price_pool: "", price_quote: quotes.find((q) => q.label === "WETH")?.address ?? quotes[0].address, price_hook: "" };
}
const EMPTY = emptyDraft(PAIR_CHAINS[0]);
type Draft = ReturnType<typeof emptyDraft>;

/**
 * Community pairs for moderators: every pair with its status and the monitor's reading, Suspend / Delist / Reinstate
 * with a reason, and the form that lists a pair or changes one. Each action is an admin-wallet signature; the server
 * reads the token and its price pool before it writes, and every change lands on the pair's public record.
 */
export default function PairsAdmin() {
  const { address } = useAdminAccount();
  const config = useConfig();
  const [pairs, setPairs] = useState<PairPublic[] | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/pairs", { cache: "no-store" });
      if (res.ok) setPairs(((await res.json()) as { pairs: PairPublic[] }).pairs);
    } catch {
      // keep the last list
    }
  }, []);
  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  async function act(action: PairAdminAction, chain: ChainKey, pair: string, extra: { listing?: PairListing; reason?: string }) {
    if (!address) return;
    setBusy(true);
    setMsg(null);
    try {
      const n = nonce();
      const ts = nowMs();
      // signed on Base like every pair signature, whatever chain the pair is on
      const wallet = await walletOnChain(config, CHAINS[PAIR_FEE_CHAIN].id);
      const signature = await wallet.signMessage({ message: buildPairAdminMessage({ action, chain, address: pair, wallet: address, nonce: n, ts, ...extra }) });
      const res = await fetch("/api/pairs/mod", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, chain, address: pair, wallet: address, nonce: n, ts, signature, ...(extra.listing ?? {}), ...(extra.reason !== undefined ? { reason: extra.reason } : {}) }) });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `request failed (HTTP ${res.status})`);
      setMsg({ ok: true, text: `${action}: ${pair} (${CHAIN_LABELS[chain]})` });
      if (action === "list" || action === "update") setDraft(EMPTY);
      await load();
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  }

  const listing = (d: Draft): PairListing => ({ logo: d.logo.trim(), website: d.website.trim(), x_handle: d.x_handle.trim().replace(/^@/, ""), description: d.description.trim(), price_kind: d.price_kind, price_pool: d.price_pool.trim().toLowerCase(), price_quote: d.price_quote.toLowerCase(), price_hook: d.price_kind === "univ4" ? d.price_hook.trim().toLowerCase() : "" });
  const editing = pairs?.some((p) => p.chain === draft.chain && p.address === draft.address.trim().toLowerCase() && p.status !== "delisted") ?? false;
  const quotes = coreQuoteOptions(draft.chain);
  const field = "min-h-9 w-full rounded-lg border border-line bg-paper px-3 text-xs text-ink";

  return (
    <section className="space-y-3" aria-labelledby="pairs-admin-heading">
      <h2 id="pairs-admin-heading" className="text-lg font-semibold text-ink">Community pairs</h2>
      {!address ? <p className={`${card} p-6 text-sm text-muted`}>Connect the admin wallet.</p> : null}
      {pairs?.length === 0 ? <p className={`${card} p-6 text-sm text-muted`}>No pairs yet.</p> : null}
      {pairs?.map((p) => (
        <div key={`${p.chain}:${p.address}`} className={`${card} space-y-2 p-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <Link href={pairPath(p.chain, p.address)} className="font-semibold text-ink">{p.symbol}</Link>
            <span className="font-mono text-[11px] text-muted">{CHAIN_LABELS[p.chain]} · {p.status} · {p.price_kind} · {p.usd !== null ? fmtUsd(p.usd) : "no price"}{p.failing_since ? ` · failing since ${p.failing_since.slice(0, 16)}` : ""}</span>
          </div>
          {p.status_reason ? <p className="text-xs text-muted">{p.status_reason}</p> : null}
          <div className="flex flex-wrap gap-2">
            <input aria-label={`Reason for ${p.symbol}`} value={reasons[`${p.chain}:${p.address}`] ?? ""} onChange={(e) => setReasons((r) => ({ ...r, [`${p.chain}:${p.address}`]: e.target.value }))} placeholder="Reason (shown on its record)" maxLength={200} className={`${field} min-w-0 flex-1`} />
            {p.status === "listed" ? <button type="button" disabled={!address || busy || !reasons[`${p.chain}:${p.address}`]?.trim()} onClick={() => void act("suspend", p.chain, p.address, { reason: reasons[`${p.chain}:${p.address}`].trim() })} className={`${btn.secondarySm} text-down-ink`}>Suspend</button> : null}
            {p.status !== "delisted" ? <button type="button" disabled={!address || busy || !reasons[`${p.chain}:${p.address}`]?.trim()} onClick={() => void act("delist", p.chain, p.address, { reason: reasons[`${p.chain}:${p.address}`].trim() })} className={`${btn.secondarySm} text-down-ink`}>Delist</button> : null}
            {p.status !== "listed" ? <button type="button" disabled={!address || busy} onClick={() => void act("reinstate", p.chain, p.address, { reason: reasons[`${p.chain}:${p.address}`]?.trim() ?? "" })} className={btn.secondarySm}>Reinstate</button> : null}
            {p.status !== "delisted" ? <button type="button" disabled={busy} onClick={() => setDraft({ chain: p.chain, address: p.address, logo: p.logo ?? "", website: p.website ?? "", x_handle: p.x_handle ?? "", description: p.description ?? "", price_kind: p.price_kind, price_pool: p.price_pool, price_quote: p.price_quote, price_hook: p.price_hook ?? "" })} className={btn.secondarySm}>Edit</button> : null}
          </div>
        </div>
      ))}
      <form className={`${card} grid gap-2 p-4 sm:grid-cols-2`} onSubmit={(e) => { e.preventDefault(); void act(editing ? "update" : "list", draft.chain, draft.address.trim().toLowerCase(), { listing: listing(draft) }); }}>
        <p className="text-sm font-semibold text-ink sm:col-span-2">{editing ? "Change a pair" : "List a pair"}</p>
        <select aria-label="Chain" value={draft.chain} disabled={editing} onChange={(e) => { const chain = e.target.value as ChainKey; setDraft({ ...draft, chain, price_quote: emptyDraft(chain).price_quote }); }} className={`${field} sm:col-span-2`}>
          {PAIR_CHAINS.map((c) => <option key={c} value={c}>{CHAIN_LABELS[c]}</option>)}
        </select>
        <input aria-label="Token address" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value.trim() })} placeholder="Token address 0x…" className={`${field} font-mono sm:col-span-2`} />
        <select aria-label="Price source" value={draft.price_kind} onChange={(e) => setDraft({ ...draft, price_kind: e.target.value as PairPriceKind })} className={field}>
          {PAIR_PRICE_KINDS.map((k) => <option key={k} value={k}>{k}: {PAIR_PRICE_KIND_LABEL[k]}</option>)}
        </select>
        <select aria-label="Pool's other token" value={draft.price_quote} onChange={(e) => setDraft({ ...draft, price_quote: e.target.value })} className={field}>
          {quotes.map((q) => <option key={q.address} value={q.address}>against {q.label}</option>)}
        </select>
        <input aria-label="Price pool" value={draft.price_pool} onChange={(e) => setDraft({ ...draft, price_pool: e.target.value.trim() })} placeholder={draft.price_kind === "univ4" ? "v4 pool id 0x… (64 hex)" : draft.price_kind === "launch" ? "the launched token (its own address)" : "v3 pool address 0x…"} className={`${field} font-mono sm:col-span-2`} />
        {draft.price_kind === "univ4" ? <input aria-label="Pool hook" value={draft.price_hook} onChange={(e) => setDraft({ ...draft, price_hook: e.target.value.trim() })} placeholder="The pool's hook 0x… (empty = hookless; the server checks it against the pool's key)" className={`${field} font-mono sm:col-span-2`} /> : null}
        <input aria-label="Logo URL" value={draft.logo} onChange={(e) => setDraft({ ...draft, logo: e.target.value })} placeholder="Logo: uploaded image URL, or /file.png" maxLength={300} className={field} />
        <input aria-label="Website" value={draft.website} onChange={(e) => setDraft({ ...draft, website: e.target.value })} placeholder="https://…" maxLength={200} className={field} />
        <input aria-label="X handle" value={draft.x_handle} onChange={(e) => setDraft({ ...draft, x_handle: e.target.value })} placeholder="X handle" className={field} />
        <textarea aria-label="About" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="About (one or two sentences, 280 max)" maxLength={280} className={`${field} min-h-16 py-2 sm:col-span-2`} />
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button type="submit" disabled={!address || busy || !isAddress(draft.address.trim())} className={btn.primarySm}>{editing ? "Sign and update" : "Sign and list"}</button>
          {draft !== EMPTY ? <button type="button" onClick={() => setDraft(EMPTY)} className={btn.secondarySm}>Clear</button> : null}
        </div>
      </form>
      {msg ? <p role="status" className={`text-xs ${msg.ok ? "text-up" : "text-down-ink"}`}>{msg.text}</p> : null}
    </section>
  );
}
