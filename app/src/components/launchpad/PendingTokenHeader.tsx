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
 */
export default function PendingTokenHeader() {
  const pathname = usePathname();
  const note = useSyncExternalStore(subscribePendingToken, getPendingToken, () => null);
  const p = pendingTokenFor(pathname, note);
  return (
    <header className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        {p ? (
          <MorphAvatar chain={p.chain} token={p.token}>
            <TokenAvatar chain={p.chain} token={p.token} symbol={p.symbol} image={p.image} size={56} className="shrink-0 rounded-2xl" />
          </MorphAvatar>
        ) : (
          <Sk className="size-14 shrink-0 rounded-2xl" />
        )}
        <div className="min-w-0">
          {p ? (
            <MorphName chain={p.chain} token={p.token}>
              <h1 className="break-words font-display text-2xl font-bold tracking-[-0.03em] text-ink sm:text-3xl">{p.name}</h1>
            </MorphName>
          ) : (
            <Sk className="h-8 w-48" />
          )}
          <Sk className="mt-2 h-3 w-60 max-w-full" />
        </div>
      </div>
    </header>
  );
}
