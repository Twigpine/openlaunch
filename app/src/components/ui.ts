/** Shared class strings for the "Clear Sky" design system. Presentation only. */

const btnBase =
  "ui-pressable inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold text-sm whitespace-nowrap motion-reduce:transition-none disabled:opacity-40 disabled:cursor-not-allowed select-none";

export const btn = {
  primary: `${btnBase} min-h-11 px-5 bg-brand text-inverse hover:bg-brand-strong`,
  primarySm: `${btnBase} min-h-9 px-3.5 text-[13px] bg-brand text-inverse hover:bg-brand-strong`,
  secondary: `${btnBase} min-h-11 px-5 bg-line text-ink hover:bg-line-strong`,
  secondarySm: `${btnBase} min-h-9 px-3.5 text-[13px] bg-line text-ink hover:bg-line-strong`,
  soft: `${btnBase} min-h-11 px-5 bg-brand-soft text-brand hover:bg-brand hover:text-inverse`,
  softSm: `${btnBase} min-h-9 px-3.5 text-[13px] bg-brand-soft text-brand hover:bg-brand hover:text-inverse`,
  up: `${btnBase} min-h-11 px-5 bg-up text-inverse hover:brightness-110`,
  // bg-warm-ink, not bg-warm: white on #d97706 is 3.19:1, below AA for a filled control.
  warm: `${btnBase} min-h-11 px-5 bg-warm-ink text-inverse hover:brightness-110`,
  warmOutline: `${btnBase} min-h-11 px-5 bg-warm-soft text-warm-ink border border-warm/40 hover:border-warm`,
  icon: `${btnBase} h-10 w-10 rounded-xl text-ink hover:bg-paper border border-transparent hover:border-line`,
};

export const card = "rounded-2xl bg-card border border-line shadow-card";
export const cardPad = `${card} p-5`;

/** Small uppercase eyebrow label (Inter 11px). Use sparingly. */
export const eyebrow = "text-[11px] font-semibold uppercase tracking-[0.08em] text-muted";

export const input =
  "w-full rounded-xl bg-card border border-line-strong focus:border-brand focus:ring-4 focus:ring-brand/10 outline-none h-12 px-4 text-base text-ink placeholder:text-faint transition-shadow";

export const label = "block text-sm font-medium text-ink mb-1.5";
export const helper = "mt-1.5 text-xs text-muted";

export const pill = "inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-xs font-medium text-body whitespace-nowrap";

export const codeBlock =
  "overflow-x-auto rounded-xl bg-paper border border-line px-4 py-3 font-mono text-[13px] leading-relaxed text-ink bb-scroll";
