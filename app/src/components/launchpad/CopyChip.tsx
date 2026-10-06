"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** The chip's own look. A `className` replaces it entirely, so a toolbar can draw the button as one of its segments. */
const CHIP = "inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-card px-2.5 font-code text-[11px] text-body hover:border-line-strong hover:text-ink";

export default function CopyChip({ value, label, className = CHIP }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const shown = label ?? `${value.slice(0, 6)}…${value.slice(-4)}`;
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          } catch {
            /* clipboard blocked */
          }
        }}
        className={className}
        title={value}
        aria-label={`Copy ${shown}`}
      >
        {shown}
        {done ? <Check size={13} aria-hidden="true" className="shrink-0 text-up" /> : <Copy size={13} aria-hidden="true" className="shrink-0 text-faint" />}
      </button>
      {/* outside the button: a button's children are presentational, so a live region inside it may never be read */}
      <span role="status" className="sr-only">{done ? "Copied" : ""}</span>
    </>
  );
}
