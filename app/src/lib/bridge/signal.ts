import type { BridgePhase } from "./client";
import type { BridgeChainId } from "./types";

/**
 * The bridge's signal board: a dot-matrix strip that spells the two networks and runs lights along the route between
 * them. Everything here is pure (which dots exist, how bright each is at a given moment) so the canvas component only
 * paints, and the board can never say something the transfer state does not.
 */

/** Board spellings. Five-by-seven letters, so every code must use only the letters in GLYPHS. */
export const SIGNAL_CODES: Record<BridgeChainId, string> = { 8453: "BASE", 4663: "HOOD", 5042: "ARC", 99901: "ELYS", 1: "ETH", 42161: "ARB", 10: "OP" };

/** Light colours per network, chosen to read on the board's dark plate (not brand-exact). */
export const SIGNAL_COLORS: Record<BridgeChainId, readonly [number, number, number]> = {
  8453: [61, 124, 255],
  4663: [204, 255, 0],
  5042: [196, 208, 226],
  99901: [151, 252, 228], // HYPE's mint
  1: [136, 154, 255],
  42161: [18, 170, 255],
  10: [255, 72, 92],
};
export const SIGNAL_OK: readonly [number, number, number] = [61, 220, 151];
export const SIGNAL_WARN: readonly [number, number, number] = [251, 191, 36];

export const SIGNAL_ROWS = 15;
const GLYPH_WIDTH = 5;
const GLYPH_TOP = 4;
const MARGIN = 2;

const GLYPHS: Record<string, readonly string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
};

export type SignalCell = readonly [number, number];

/** The lit dots of a code, left to right with one empty column between letters. */
export function glyphCells(code: string): { width: number; cells: SignalCell[] } {
  const cells: SignalCell[] = [];
  [...code].forEach((letter, index) => {
    const rows = GLYPHS[letter];
    if (!rows) throw new Error(`The signal board has no letter "${letter}".`);
    rows.forEach((row, y) => [...row].forEach((dot, x) => { if (dot === "#") cells.push([index * (GLYPH_WIDTH + 1) + x, y]); }));
  });
  return { width: code.length * (GLYPH_WIDTH + 1) - 1, cells };
}

export type SignalLayout = { cols: number; rows: number; from: SignalCell[]; to: SignalCell[]; path: SignalCell[] };

/**
 * Where everything sits on a board `cols` dots wide: the source code at the left, the destination at the right (or
 * nothing, when a step concerns one network only) and a shallow arc of route lights between them.
 */
export function signalLayout(cols: number, fromCode: string, toCode: string | null): SignalLayout {
  const from = glyphCells(fromCode);
  const to = toCode === null ? null : glyphCells(toCode);
  const toStart = to ? cols - MARGIN - to.width : cols - MARGIN;
  const start = MARGIN + from.width + 2;
  const end = toStart - (to ? 3 : 1);
  const middle = GLYPH_TOP + 3;
  const path: SignalCell[] = [];
  for (let x = start; x <= end; x++) {
    const along = end === start ? 0 : (x - start) / (end - start);
    path.push([x, middle - Math.round(Math.sin(Math.PI * along) * 3)]);
  }
  return {
    cols, rows: SIGNAL_ROWS, path,
    from: from.cells.map(([x, y]) => [MARGIN + x, GLYPH_TOP + y] as const),
    to: to ? to.cells.map(([x, y]) => [toStart + x, GLYPH_TOP + y] as const) : [],
  };
}

export type SignalPitch = { pitch: number; width: number };

/**
 * Dot spacing (px) for a board `width` px wide. Sticky on purpose: the board's height follows the spacing, and inside
 * a scrolling dialog a taller board can add a scrollbar, which narrows the board, which would shrink it again. So a
 * spacing, once chosen, holds until the width moves by more than a scrollbar's worth.
 */
export function signalPitch(width: number, previous: SignalPitch | null): SignalPitch {
  if (previous && Math.abs(width - previous.width) <= 24) return previous;
  return { pitch: Math.min(10, Math.max(3, Math.floor(width / 66))), width };
}

/** The narrowest board that still leaves a route between two four-letter codes. */
export const SIGNAL_MIN_COLS = 2 * (4 * (GLYPH_WIDTH + 1) - 1) + 2 * MARGIN + 12;

export type SignalMode = "idle" | "quoting" | "ready" | "expired" | "blocked" | "approval" | "wallet" | "transit" | "arrived" | "refund" | "attention";

/**
 * What the board shows, from the transfer state alone. A wallet step always wins over a quote, a tracked transfer over
 * both, and anything unknown or failed is "attention": the board never shows movement the app cannot stand behind.
 */
export function signalMode(state: { phase: BridgePhase; tracked: boolean; approvalActive: boolean; quoteLoading: boolean; reviewing: boolean; quoteExpired: boolean; blocked: boolean }): SignalMode {
  if (state.tracked) {
    if (state.phase === "success") return "arrived";
    if (state.phase === "refund") return "refund";
    if (state.phase === "pending") return "transit";
    if (state.phase === "confirming" || state.phase === "switching") return "wallet";
    return "attention";
  }
  if (state.approvalActive) return "approval";
  if (state.phase === "confirming" || state.phase === "switching") return "wallet";
  if (state.quoteLoading) return "quoting";
  if (state.quoteExpired) return "expired";
  if (state.reviewing) return "ready";
  if (state.blocked) return "blocked";
  return "idle";
}

/** The short line under the board. Decorative: the panel's own status text carries the meaning for screen readers. */
export function signalCaption(mode: SignalMode, destinationName: string): string {
  switch (mode) {
    case "quoting": return "Finding route";
    case "ready": return "Quote ready";
    case "expired": return "Quote expired";
    case "blocked": return "No quote";
    case "approval": return "Approval step";
    case "wallet": return "Check wallet";
    case "transit": return "In transit";
    case "arrived": return `Arrived on ${destinationName}`;
    case "refund": return "Refund reported";
    case "attention": return "Needs attention";
    default: return "Standing by";
  }
}

export type SignalTone = "route" | "ok" | "warn";

const trail = (position: number, index: number, length: number) => {
  const behind = position - index;
  return behind >= 0 && behind < length ? 1 - behind / length : 0;
};

/** Brightness (0 to 1) and colour of route light `index` of `count`, `seconds` into the animation. */
export function routeLight(mode: SignalMode, seconds: number, index: number, count: number): { level: number; tone: SignalTone } {
  const span = count + 10;
  const packets = (amount: number, speed: number, length: number, reverse = false) => {
    let glow = 0;
    for (let k = 0; k < amount; k++) {
      const position = ((seconds * speed + k / amount) % 1) * span - 5;
      glow = Math.max(glow, trail(position, reverse ? count - 1 - index : index, length));
    }
    return glow;
  };
  switch (mode) {
    case "transit": return { level: 0.2 + 0.8 * packets(4, 1.15, 9), tone: "route" };
    case "ready": return { level: 0.2 + 0.8 * packets(1, 0.28, 8), tone: "route" };
    case "quoting": {
      // one light sweeping there and back: looking, not sending
      const swing = Math.abs(((seconds * 0.9) % 2) - 1) * (count - 1);
      return { level: 0.16 + 0.84 * Math.max(0, 1 - Math.abs(swing - index) / 4), tone: "route" };
    }
    case "wallet":
    case "approval":
      // the first lights knock at the source: waiting on the wallet, nothing has left
      return { level: index < 4 ? 0.3 + 0.6 * (0.5 + 0.5 * Math.sin(seconds * 6 - index)) : 0.14, tone: "route" };
    case "arrived": return { level: 0.9, tone: "ok" };
    case "refund": return { level: 0.2 + 0.8 * packets(2, 0.6, 8, true), tone: "warn" };
    case "attention": return { level: 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(seconds * 3)), tone: "warn" };
    case "expired": return { level: 0.12, tone: "route" };
    case "blocked": return { level: 0.1, tone: "warn" };
    default: return { level: 0.16, tone: "route" };
  }
}

/** Brightness of the two codes. The destination only lights fully once funds are reported there. */
export function codeLights(mode: SignalMode, seconds: number): { from: number; to: number; toTone: "chain" | "ok" | "warn" } {
  switch (mode) {
    case "arrived": return { from: 0.55, to: 1, toTone: "ok" };
    case "transit": return { from: 0.6 + 0.25 * Math.sin(seconds * 9), to: 0.5, toTone: "chain" };
    case "refund": return { from: 0.9, to: 0.4, toTone: "warn" };
    case "attention": return { from: 0.8, to: 0.4, toTone: "warn" };
    case "ready": return { from: 0.95, to: 0.75, toTone: "chain" };
    case "wallet":
    case "approval": return { from: 0.7 + 0.3 * Math.sin(seconds * 6), to: 0.4, toTone: "chain" };
    default: return { from: 0.9, to: 0.45, toTone: "chain" };
  }
}
