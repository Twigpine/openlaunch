"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Search } from "lucide-react";
import Sheet from "@/components/Sheet";
import TokenAvatar from "./TokenAvatar";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { isSearchableQuery, paletteTokenFrom, type PaletteToken } from "@/lib/command-palette";
import { marketUsd } from "@/lib/launchpad/market-format";
import { setPendingToken } from "@/lib/launchpad/token-transition";
import { BOOST_CHAIN, BOOST_COPY } from "@/lib/launchpad/boost";

type LaunchesResponse = { launches?: Parameters<typeof paletteTokenFrom>[0][] };

/** How many of the wallet's own launches lead the list, and how many trending tokens fill it before anything is typed. */
const MINE_MAX = 5;
const TRENDING_MAX = 6;
/** Trending is kept this long across opens of the picker, so reopening it asks for nothing. */
const TRENDING_TTL_MS = 60_000;
let trendingCache: { at: number; tokens: PaletteToken[] } | null = null;
const freshTrending = () => (trendingCache && Date.now() - trendingCache.at < TRENDING_TTL_MS ? trendingCache.tokens : null);

/**
 * "Boost a token" from the Boosted lane: pick a Base token, land on its page with the boost dialog open
 * (`?boost=1#boost`, the same link /me's Boost uses). Nothing is sent from here: the token's page shows the amount, the
 * lane and the burn before the wallet is asked, with every check the dialog has. The connected wallet's own Base
 * launches come first (their creators are the likeliest boosters), then a search of Base tokens, or what is trending
 * on Base before anything is typed. A token an admin keeps out of the lane says so here, instead of sending the
 * visitor to a page with no Boost button.
 */
export default function BoostPicker({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { address } = useHydratedAccount();
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [mine, setMine] = useState<{ wallet: string; tokens: PaletteToken[] } | null>(null);
  const [trending, setTrending] = useState<PaletteToken[] | null>(freshTrending);
  const [results, setResults] = useState<{ q: string; tokens: PaletteToken[]; failed: boolean } | null>(null);
  // the token being checked before leaving, and the ones an admin keeps out of the lane
  const [checking, setChecking] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  // the check a pick is waiting on; closing the picker aborts it, and an aborted check never navigates
  const pickCheck = useRef<AbortController | null>(null);
  useEffect(() => () => pickCheck.current?.abort(), []);

  // the wallet's own Base launches, newest first: only the few shown are asked for
  const wallet = address?.toLowerCase() ?? null;
  useEffect(() => {
    if (!wallet) return;
    const ac = new AbortController();
    fetch(`/api/launch/list?chain=${BOOST_CHAIN}&launcher=${wallet}&sort=new&limit=${MINE_MAX}`, { signal: ac.signal, cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<LaunchesResponse>) : null))
      .then((j) => setMine({ wallet, tokens: (j?.launches ?? []).filter((l) => l.chain === BOOST_CHAIN).slice(0, MINE_MAX).map(paletteTokenFrom) }))
      .catch(() => {
        if (!ac.signal.aborted) setMine({ wallet, tokens: [] });
      });
    return () => ac.abort();
  }, [wallet]);

  useEffect(() => {
    if (freshTrending()) return;
    const ac = new AbortController();
    fetch(`/api/launch/list?chain=${BOOST_CHAIN}&sort=live&limit=${TRENDING_MAX}`, { signal: ac.signal, cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<LaunchesResponse>) : null))
      .then((j) => {
        const tokens = (j?.launches ?? []).filter((l) => l.chain === BOOST_CHAIN).map(paletteTokenFrom);
        if (j) trendingCache = { at: Date.now(), tokens };
        setTrending(tokens);
      })
      .catch(() => {
        if (!ac.signal.aborted) setTrending([]);
      });
    return () => ac.abort();
  }, []);

  // Base tokens only, debounced; a late answer for an older query is dropped
  const q = query.trim();
  useEffect(() => {
    if (!isSearchableQuery(q)) return;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/launch/search?q=${encodeURIComponent(q)}&chain=${BOOST_CHAIN}&order=holders`, { signal: ac.signal, cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<LaunchesResponse>) : Promise.reject(new Error(String(r.status)))))
        .then((j) => setResults({ q, tokens: (j.launches ?? []).filter((l) => l.chain === BOOST_CHAIN).slice(0, 8).map(paletteTokenFrom), failed: false }))
        .catch(() => {
          if (!ac.signal.aborted) setResults({ q, tokens: [], failed: true });
        });
    }, 160);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [q]);

  // the boost happens on the token's page: this only navigates there, with the dialog asked to open. A token an admin
  // keeps out of the lane has no Boost button there, so it is checked first; a failed check just goes (the page says).
  const pick = async (t: PaletteToken) => {
    if (checking) return;
    setChecking(t.token);
    const ac = new AbortController();
    pickCheck.current = ac;
    const kept = await fetch(`/api/boost?chain=${BOOST_CHAIN}&token=${t.token}`, { cache: "no-store", signal: ac.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ enabled?: boolean; hidden?: boolean }>) : null))
      .then((d) => d?.enabled === true && d.hidden === true)
      .catch(() => false);
    // the visitor closed the picker while it checked: they dismissed it, so nothing more happens
    if (ac.signal.aborted) return;
    pickCheck.current = null;
    setChecking(null);
    if (kept) {
      setHidden((h) => new Set(h).add(t.token));
      return;
    }
    setPendingToken({ chain: t.chain, token: t.token, name: t.name, symbol: t.symbol, image: t.image });
    onClose();
    router.push(`/t/${BOOST_CHAIN}/${t.token}?boost=1#boost`);
  };
  const row = { onPick: (t: PaletteToken) => void pick(t), checking, hidden };

  const searching = isSearchableQuery(q);
  const current = results && results.q === q ? results : null;
  const own = mine && mine.wallet === wallet ? mine.tokens : [];
  const status = searching ? (current ? (current.failed ? BOOST_COPY.pickerFailed : current.tokens.length === 0 ? BOOST_COPY.pickerNone : "") : "Searching…") : "";

  return (
    <Sheet title={BOOST_COPY.cta} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-pretty text-xs leading-relaxed text-body">{BOOST_COPY.pickerNote}</p>
        <div className="flex items-center gap-2.5 rounded-xl border border-line-strong bg-paper px-3 focus-within:border-transparent focus-within:ring-2 focus-within:ring-brand/60">
          <Search size={15} aria-hidden="true" className="shrink-0 text-muted" />
          <label htmlFor={inputId} className="sr-only">{BOOST_COPY.pickerSearch}</label>
          {/* 16px on a phone: iOS zooms the page into any smaller input it focuses */}
          <input
            id={inputId}
            type="search"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, symbol or address"
            className="min-h-11 min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-faint focus-visible:outline-none! sm:text-sm"
          />
        </div>
        <p role="status" aria-live="polite" className="text-xs text-muted empty:hidden">{status}</p>
        {searching ? (
          current && current.tokens.length > 0 ? <TokenList tokens={current.tokens} {...row} /> : null
        ) : (
          <>
            {own.length > 0 ? <TokenList title={BOOST_COPY.pickerMine} tokens={own} {...row} /> : null}
            {trending === null ? <p className="text-xs text-muted">Loading…</p> : trending.length > 0 ? <TokenList title={BOOST_COPY.pickerTrending} tokens={trending} {...row} /> : null}
          </>
        )}
      </div>
    </Sheet>
  );
}

function TokenList({ title, tokens, onPick, checking, hidden }: { title?: string; tokens: readonly PaletteToken[]; onPick: (t: PaletteToken) => void; checking: string | null; hidden: ReadonlySet<string> }) {
  const titleId = useId();
  return (
    <section aria-labelledby={title ? titleId : undefined}>
      {title ? <h3 id={titleId} className="mb-1.5 text-[11px] font-medium text-muted">{title}</h3> : null}
      <ul className="-mx-2 space-y-0.5">
        {tokens.map((t) => (
          <li key={t.token}>
            <button
              type="button"
              onClick={() => onPick(t)}
              disabled={hidden.has(t.token) || (checking !== null && checking !== t.token)}
              aria-busy={checking === t.token}
              className="group flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--color-warm-soft)_70%,var(--color-card))] focus-visible:bg-[color-mix(in_oklab,var(--color-warm-soft)_70%,var(--color-card))] active:bg-warm-soft disabled:cursor-default disabled:hover:bg-transparent motion-reduce:transition-none"
            >
              <TokenAvatar chain={t.chain} token={t.token} symbol={t.symbol} image={t.image} size={32} className="shrink-0 rounded-xl" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-ink">{t.name}</span>
                <span className="block truncate text-[11px] text-muted"><span className="font-mono text-body">{t.symbol}</span>{t.capUsd !== null ? <><span aria-hidden="true"> · </span><span className="sr-only">, market cap </span><span className="font-mono tnum">{marketUsd(t.capUsd)}</span></> : null}</span>
              </span>
              {hidden.has(t.token) ? (
                <span className="shrink-0 text-right text-[11px] text-muted">{BOOST_COPY.pickerHidden}</span>
              ) : (
                <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-warm-ink">{checking === t.token ? "Opening…" : "Boost"}<ChevronRight size={13} aria-hidden="true" className="transition-transform duration-150 motion-safe:group-hover:translate-x-0.5" /></span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
