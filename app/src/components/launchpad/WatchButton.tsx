"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Star } from "lucide-react";
import { watchlistKey, type WatchlistIdentity } from "@/lib/launchpad/watchlist";
import { useWatchlist } from "./useWatchlist";

/**
 * Kept outside token links: saving must never navigate or request a signature. `overlay` sits on a market card's art
 * (dark glass); `labelled` is the token page's action bar button, the same height as the bar beside it.
 */
export default function WatchButton({ token, labelled = false, overlay = false, onRemoved }: { token: WatchlistIdentity; labelled?: boolean; overlay?: boolean; onRemoved?: (button: HTMLButtonElement) => void }) {
  const { savedKeys, ready, toggle, storageError } = useWatchlist();
  const reduced = useReducedMotion();
  const [message, setMessage] = useState("");
  const saved = savedKeys.includes(watchlistKey(token));
  const label = `${saved ? "Remove" : "Save"} ${token.name} ${saved ? "from" : "to"} watchlist`;
  const star = (
    // the press feedback is the button's own :active state, in CSS. A tap gesture in Motion makes the element focusable
    // (tabindex="0"), and under reduced motion the server and the client then disagree about that attribute
    <motion.span initial={false} animate={{ scale: saved && !reduced ? [1, 1.3, 1] : 1, rotate: saved && !reduced ? [0, -12, 0] : 0 }} transition={{ duration: reduced ? 0 : 0.24 }} className="inline-flex transition-[scale] duration-100 group-active/star:scale-[.88] motion-reduce:transition-none motion-reduce:group-active/star:scale-100">
      <Star size={overlay ? 14 : labelled ? 15 : 17} aria-hidden="true" fill={saved ? "currentColor" : "none"} strokeWidth={1.7} />
    </motion.span>
  );
  return (
    <span className="relative inline-flex shrink-0">
      <button type="button" disabled={!ready} aria-label={label} aria-pressed={saved} title={label}
        onClick={(event) => {
          const result = toggle(token);
          setMessage(result === "limit" ? "Your watchlist is full. Remove a token to save another (50 maximum)." : result === "invalid" ? "This token could not be saved." : "");
          if (result === "removed") onRemoved?.(event.currentTarget);
        }}
        className={overlay
          ? "group/star inline-flex size-8 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/15 backdrop-blur-md transition-colors hover:bg-black/70 disabled:opacity-40 motion-reduce:transition-none"
          : labelled
            ? `group/star inline-flex h-10 items-center justify-center rounded-xl border px-3 text-xs font-medium transition-colors disabled:opacity-40 motion-reduce:transition-none sm:h-9 ${saved ? "border-brand/40 bg-brand-soft text-brand" : "border-line bg-card text-body hover:border-line-strong hover:text-ink"}`
            : `group/star inline-flex min-h-11 w-11 items-center justify-center rounded-xl transition-colors disabled:opacity-40 motion-reduce:transition-none ${saved ? "text-brand" : "text-muted hover:text-ink"}`}>
        {/* the wider word sizes the button, so the bar beside it never shifts; the star and word stay centred together */}
        {labelled ? (
          <span className="grid justify-items-center">
            <span className="col-start-1 row-start-1 inline-flex items-center gap-1.5">{star}{saved ? "Watching" : "Watch"}</span>
            <span aria-hidden="true" className="invisible col-start-1 row-start-1 inline-flex items-center gap-1.5"><span className="size-[15px]" />Watching</span>
          </span>
        ) : star}
      </button>
      {message ? <span role="alert" className="absolute left-0 top-full z-20 w-52 rounded-xl border border-line-strong bg-paper p-3 text-xs text-warm-ink">{message}</span> : null}
      {storageError && labelled ? <span role="status" className="sr-only">Browser storage unavailable. Saved for this session only.</span> : null}
    </span>
  );
}
