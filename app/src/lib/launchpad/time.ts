export type AgoUnit = "s" | "m" | "h" | "d";

/** How long ago, as a count and its largest whole unit; the words come from the reader's language (`useAgo`). */
export function agoParts(iso: string, now: number): { n: number; unit: AgoUnit } {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return { n: 0, unit: "s" };
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return { n: s, unit: "s" };
  if (s < 3600) return { n: Math.floor(s / 60), unit: "m" };
  if (s < 86400) return { n: Math.floor(s / 3600), unit: "h" };
  return { n: Math.floor(s / 86400), unit: "d" };
}

/** "12s" / "3m" / "5h" / "2d" — shared by server and client components. */
export function ago(iso: string, now: number): string {
  const { n, unit } = agoParts(iso, now);
  return `${n}${unit}`;
}

/** Render-time clock for dynamic (force-dynamic) server pages that show "ago" labels. */
export function nowMs(): number {
  return Date.now();
}
