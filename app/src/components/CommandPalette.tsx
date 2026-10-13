"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Dialog } from "@base-ui/react/dialog";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { ArrowLeftRight, CornerDownLeft, FileText, Moon, Search, Sun } from "lucide-react";
import TokenAvatar from "@/components/launchpad/TokenAvatar";
import { CHAIN_SHORT } from "@/lib/chainPublic";
import { marketChange, marketUsd } from "@/lib/launchpad/market-format";
import { setPendingToken } from "@/lib/launchpad/token-transition";
import { buildPaletteGroups, isSearchableQuery, paletteTokenFrom, type PaletteGroup, type PaletteItem, type PaletteToken } from "@/lib/command-palette";
import { useOpenBridge } from "./bridge/BridgeProvider";

type LaunchesResponse = { launches?: Parameters<typeof paletteTokenFrom>[0][] };

/**
 * ⌘K search: tokens (by name, symbol or address), pages and a few actions, from any screen.
 * Base UI's Dialog + inline Autocomplete own focus, keyboard navigation and the listbox semantics.
 */
export default function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const openBridge = useOpenBridge();
  const hintId = useId();
  const [query, setQuery] = useState("");
  const [trending, setTrending] = useState<PaletteToken[] | null>(null);
  const [results, setResults] = useState<{ q: string; tokens: PaletteToken[]; failed: boolean } | null>(null);

  // What is trending fills the list before anything is typed. Fetched once, on the first open.
  useEffect(() => {
    if (!open || trending !== null) return;
    const ac = new AbortController();
    fetch("/api/launch/list?sort=trending&limit=6", { signal: ac.signal, cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<LaunchesResponse>) : null))
      .then((j) => setTrending((j?.launches ?? []).map(paletteTokenFrom)))
      .catch(() => {
        if (!ac.signal.aborted) setTrending([]);
      });
    return () => ac.abort();
  }, [open, trending]);

  // Token search, debounced; a late answer for an older query is dropped.
  const q = query.trim();
  useEffect(() => {
    if (!open || !isSearchableQuery(q)) return;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      // order=holders: among equally relevant names, the token people actually hold comes first
      fetch(`/api/launch/search?q=${encodeURIComponent(q)}&order=holders`, { signal: ac.signal, cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<LaunchesResponse>) : Promise.reject(new Error(String(r.status)))))
        .then((j) => setResults({ q, tokens: (j.launches ?? []).slice(0, 8).map(paletteTokenFrom), failed: false }))
        .catch(() => {
          if (!ac.signal.aborted) setResults({ q, tokens: [], failed: true });
        });
    }, 160);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [open, q]);

  const current = results && results.q === q ? results : null;
  const searching = isSearchableQuery(q) && !current;
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const groups = useMemo(() => buildPaletteGroups({ query, tokens: current?.tokens ?? [], trending: trending ?? [], theme }), [query, current, trending, theme]);
  const status = searching ? "Searching tokens…" : current?.failed ? "Token search is unavailable right now. Pages and actions still work." : "";

  const close = () => {
    onOpenChange(false);
    setQuery("");
  };

  const run = (item: PaletteItem) => {
    close();
    if (item.kind === "token") {
      const t = item.token;
      setPendingToken({ chain: t.chain, token: t.token, name: t.name, symbol: t.symbol, image: t.image });
      router.push(`/t/${t.chain}/${t.token}`);
    } else if (item.kind === "page") {
      router.push(item.href);
    } else if (item.action === "bridge") {
      // let this dialog finish closing first, so focus lands in the bridge panel
      requestAnimationFrame(() => openBridge?.());
    } else {
      setTheme(theme === "dark" ? "light" : "dark");
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[90] bg-scrim/50 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
        <Dialog.Viewport className="fixed inset-0 z-[91] flex items-start justify-center overflow-hidden px-3 pt-[min(14vh,7rem)] pb-3">
          <Dialog.Popup
            aria-label="Search openlaunch"
            className="relative flex max-h-[min(36rem,calc(100dvh-6rem))] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-raised text-ink shadow-dialog transition-[opacity,translate,scale] duration-150 ease-out data-[ending-style]:-translate-y-2 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:-translate-y-2 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 motion-reduce:transition-none"
          >
            <Autocomplete.Root
              open
              inline
              items={groups}
              filter={null}
              value={query}
              onValueChange={(next, details) => {
                // choosing an item writes its label into the field; the dialog is closing, so keep the query as typed
                if (details.reason !== "item-press") setQuery(next);
              }}
              itemToStringValue={(item: PaletteItem) => item.label}
              autoHighlight="always"
              keepHighlight
            >
              {/* focus shows as the field's underline turning blue (the global ring would box the whole header row) */}
              <Autocomplete.InputGroup className="flex items-center gap-3 border-b border-line px-4 transition-colors focus-within:border-brand">
                <Search size={18} className="shrink-0 text-muted" aria-hidden />
                <Autocomplete.Input
                  aria-label="Search tokens, pages and actions"
                  aria-describedby={hintId}
                  placeholder="Search tokens by name, symbol or address"
                  className="h-14 w-full border-0 bg-transparent text-base text-ink outline-none! placeholder:text-muted"
                />
                <Dialog.Close className="shrink-0 rounded-md border border-line-strong px-1.5 py-0.5 font-mono text-[11px] text-muted hover:text-ink">Esc</Dialog.Close>
              </Autocomplete.InputGroup>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2 [scroll-padding-block:0.5rem]">
                <Autocomplete.Status className="px-4 pt-1 pb-2 text-xs text-muted empty:hidden">{status}</Autocomplete.Status>
                <Autocomplete.Empty>
                  <div className="px-4 py-8 text-center text-sm text-muted">
                    {searching ? "Searching tokens…" : <>Nothing matches “{q}”. Try a token symbol or paste its contract address.</>}
                  </div>
                </Autocomplete.Empty>
                <Autocomplete.List>
                  {(group: PaletteGroup) => (
                    <Autocomplete.Group key={group.value} items={group.items} className="px-2 pb-1">
                      <Autocomplete.GroupLabel className="px-2 pt-2 pb-1.5 text-xs font-medium text-muted select-none">{group.value}</Autocomplete.GroupLabel>
                      <Autocomplete.Collection>
                        {(item: PaletteItem) => (
                          <Autocomplete.Item
                            key={item.id}
                            value={item}
                            onClick={() => run(item)}
                            className="group flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2 text-sm text-ink outline-none select-none data-[highlighted]:bg-line"
                          >
                            <PaletteRow item={item} />
                          </Autocomplete.Item>
                        )}
                      </Autocomplete.Collection>
                    </Autocomplete.Group>
                  )}
                </Autocomplete.List>
              </div>

              <div className="flex items-center gap-4 border-t border-line bg-card px-4 py-2.5 text-[11px] text-muted">
                <span id={hintId}>Use the arrow keys to move and Enter to open.</span>
                <span className="ml-auto inline-flex items-center gap-1"><CornerDownLeft size={12} aria-hidden /> Open</span>
              </div>
            </Autocomplete.Root>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteRow({ item }: { item: PaletteItem }) {
  if (item.kind === "token") {
    const t = item.token;
    const change = marketChange(t.change);
    return (
      <>
        <TokenAvatar chain={t.chain} token={t.token} symbol={t.symbol} image={t.image} size={28} className="shrink-0 rounded-lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{t.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            <span className="font-mono text-body">{t.symbol}</span>
            <span className="rounded-md border border-line px-1.5 text-[10px] leading-4">{CHAIN_SHORT[t.chain as keyof typeof CHAIN_SHORT] ?? t.chain}</span>
          </span>
        </span>
        <span className="shrink-0 text-right font-mono text-xs tnum">
          <span className="block text-ink">{t.capUsd !== null ? marketUsd(t.capUsd) : "—"}</span>
          <span className={change.direction === "up" ? "text-up" : change.direction === "down" ? "text-down-ink" : "text-muted"}>{change.label}</span>
        </span>
      </>
    );
  }
  const Icon = item.kind === "page" ? FileText : item.action === "bridge" ? ArrowLeftRight : item.label.includes("light") ? Sun : Moon;
  return (
    <>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-card text-body group-data-[highlighted]:text-ink"><Icon size={15} aria-hidden /></span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      <span className="shrink-0 text-xs text-muted">{item.kind === "page" ? "Page" : "Action"}</span>
    </>
  );
}
