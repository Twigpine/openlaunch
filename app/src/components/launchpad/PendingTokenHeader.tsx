"use client";

import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { Sk } from "@/components/Skeleton";
import TokenAvatar from "./TokenAvatar";
import { MorphAvatar, MorphName } from "./TokenMorph";
import { getPendingToken, pendingTokenFor, subscribePendingToken } from "@/lib/launchpad/token-transition";

/**
 * The token page's loading header. When the visitor arrived by tapping a market row, it already
 * shows that token's mark and name, at the same size and place as the real header, so the morph
 * from the row lands here and the page fills in around it. Otherwise it is a plain skeleton.
 * Keep the cover's height, the ring and the type sizes in step with the hero in app/t/[chain]/[token]/page.tsx.
 */
export default function PendingTokenHeader() {
  const pathname = usePathname();
  const note = useSyncExternalStore(subscribePendingToken, getPendingToken, () => null);
  const p = pendingTokenFor(pathname, note);
  return (
    <header className="relative mb-6 overflow-hidden rounded-3xl border border-line bg-card">
      {/* the cover's place; the token's own cover arrives with the page */}
      <span aria-hidden="true" className="bb-skel block h-24 sm:h-28" />
      <div className="grid gap-x-8 gap-y-4 px-4 pb-5 sm:px-6 sm:pb-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div className="flex min-w-0 items-start gap-4">
          {/* the tint is not known yet: the ring waits in the neutral line colour */}
          <span className="relative -mt-11 shrink-0 rounded-[22px] border-2 bg-card p-[3px] sm:-mt-12" style={{ borderColor: "var(--tok, var(--color-line-strong))" }}>
            {p ? (
              <MorphAvatar chain={p.chain} token={p.token}>
                <TokenAvatar chain={p.chain} token={p.token} symbol={p.symbol} image={p.image} size={72} className="shrink-0 rounded-2xl" />
              </MorphAvatar>
            ) : (
              <Sk className="size-[72px] shrink-0 rounded-2xl" />
            )}
          </span>
          <div className="min-w-0 pt-2">
            {p ? (
              <MorphName chain={p.chain} token={p.token}>
                <h1 className="break-words font-display text-2xl font-bold tracking-[-0.03em] text-ink sm:text-3xl">{p.name}</h1>
              </MorphName>
            ) : (
              <Sk className="h-8 w-48" />
            )}
            <Sk className="mt-2 h-3.5 w-56 max-w-full" />
          </div>
        </div>
        <div className="space-y-2 md:row-span-2 md:flex md:flex-col md:items-end">
          <Sk className="h-3 w-20" />
          <Sk className="h-9 w-40" />
          <Sk className="h-3 w-28" />
        </div>
        <div className="flex flex-wrap gap-2">{[88, 76, 120, 96].map((w) => <Sk key={w} className="h-9 rounded-lg" style={{ width: w }} />)}</div>
      </div>
    </header>
  );
}
