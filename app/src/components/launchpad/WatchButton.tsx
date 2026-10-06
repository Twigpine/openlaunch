"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Star } from "lucide-react";
import { watchlistKey, type WatchlistIdentity } from "@/lib/launchpad/watchlist";
import { useWatchlist } from "./useWatchlist";

/** Kept outside token links: saving must never navigate or request a signature. */
export default function WatchButton({ token, labelled = false, onRemoved }: { token: WatchlistIdentity; labelled?: boolean; onRemoved?: (button: HTMLButtonElement) => void }) {
  const { savedKeys, ready, toggle, storageError } = useWatchlist();
  const reduced = useReducedMotion();
  const [message, setMessage] = useState("");
  const saved = savedKeys.includes(watchlistKey(token));
  const label = `${saved ? "Remove" : "Save"} ${token.name} ${saved ? "from" : "to"} watchlist`;
  return (
    <span className="relative inline-flex shrink-0">
      <button type="button" disabled={!ready} aria-label={label} aria-pressed={saved} title={label}
        onClick={(event) => {
          const result = toggle(token);
          setMessage(result === "limit" ? "Your watchlist is full. Remove a token to save another (50 maximum)." : result === "invalid" ? "This token could not be saved." : "");
          if (result === "removed") onRemoved?.(event.currentTarget);
        }}
        className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl transition-colors disabled:opacity-40 motion-reduce:transition-none ${labelled ? "border border-line px-3 text-xs hover:border-line-strong" : "w-11"} ${saved ? "text-brand" : "text-muted hover:text-ink"}`}>
        <motion.span initial={false} whileTap={reduced ? undefined : { scale: 0.88 }} animate={{ scale: saved && !reduced ? [1, 1.3, 1] : 1, rotate: saved && !reduced ? [0, -12, 0] : 0 }} transition={{ duration: reduced ? 0 : 0.24 }} className="inline-flex">
          <Star size={17} aria-hidden="true" fill={saved ? "currentColor" : "none"} strokeWidth={1.7} />
        </motion.span>
        {labelled ? saved ? "Watching" : "Watch" : null}
      </button>
      {message ? <span role="alert" className="absolute left-0 top-full z-20 w-52 rounded-xl border border-line-strong bg-paper p-3 text-xs text-warm-ink">{message}</span> : null}
      {storageError && labelled ? <span role="status" className="sr-only">Browser storage unavailable. Saved for this session only.</span> : null}
    </span>
  );
}
