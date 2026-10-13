/**
 * The Trending board's own decisions (components/launchpad/TrendingStrip.tsx): which cell spans what for any number of
 * tokens, how long a bar is, when a held ranking lets go, what a hold may keep, and how a change reads aloud. Pure, node
 * --test loads it directly.
 * Which tokens are on the board, and in what order, is ranking.ts.
 */

import { STRIP_SIZE } from "./ranking";
import { marketChange } from "./market-format";
import { launchKey } from "./list-state";

/** Cards beside the leader. */
export const BOARD_RUNNERS = STRIP_SIZE - 1;

/**
 * One cell beside the leader. From 1024px the cells share a block two columns wide and two rows tall: "half" is one
 * column of one row, "wide" a whole row, "block" both rows. From 640px there are two columns: "half" is one, "wide" both.
 * Phones stack the runners and show no open spot.
 */
export type BoardCell = { kind: "runner" | "open"; lg: "half" | "wide" | "block"; sm: "half" | "wide" };

const RUNNER: BoardCell = { kind: "runner", lg: "half", sm: "half" };
const RUNNER_ROW: BoardCell = { kind: "runner", lg: "wide", sm: "half" };

/**
 * The cells for `runners` tokens after the leader (0 to BOARD_RUNNERS), in reading order. Every count fills the block
 * exactly: one or two runners take a whole row each, and an odd count ends on a dashed open spot instead of a hole.
 */
export function boardCells(runners: number): BoardCell[] {
  const n = Math.min(BOARD_RUNNERS, Math.max(0, Math.floor(runners) || 0));
  if (n === 0) return [{ kind: "open", lg: "block", sm: "wide" }];
  if (n === 1) return [RUNNER_ROW, { kind: "open", lg: "wide", sm: "half" }];
  if (n === 2) return [RUNNER_ROW, RUNNER_ROW];
  if (n === 3) return [RUNNER, RUNNER, RUNNER, { kind: "open", lg: "half", sm: "half" }];
  return [RUNNER, RUNNER, RUNNER, RUNNER];
}

/** The shortest bar a token with any wallet gets: below this a rounded 3px bar is a dot, not a length. */
export const BAR_MIN_PCT = 8;

/**
 * Bar length in percent: a token's wallets against the most on the board, on a square-root scale so 10 wallets beside
 * 250 still read as a length (20%, not 4%). The scale is the board's largest count, not the leader's: the leader is
 * held for two polls and the score has other terms (a fresh token can lead one with more wallets), and bars measured
 * against a smaller leader would all stop at 100 and tell nothing apart. No wallets, no bar.
 */
export function barWidth(wallets: number, most: number): number {
  if (!(wallets > 0)) return 0;
  if (!(most > 0) || wallets >= most) return 100;
  return Math.max(BAR_MIN_PCT, Math.round(Math.sqrt(wallets / most) * 1000) / 10);
}

/** The scale for every bar on the board: the largest wallet count shown, whoever leads. */
export function barScale(wallets: number[]): number {
  return wallets.reduce((most, n) => (n > most ? n : most), 0);
}

/** A keyboard focus left on a card holds the order for this many polls, then lets go. */
export const FOCUS_HOLD_POLLS = 3;

export type BoardHold = { pointer: boolean; focus: boolean; focusPolls: number };

/**
 * One poll's decision: re-sort, or keep the order and only refresh the figures. A mouse over the board holds for as
 * long as it stays; keyboard focus holds for FOCUS_HOLD_POLLS polls, so a forgotten focus cannot pin a stale ranking.
 * A hold only ever keeps the order of the same tokens in the same window (sameBoard below).
 */
export function holdOnPoll(hold: BoardHold): BoardHold & { held: boolean } {
  if (!hold.focus || hold.focusPolls >= FOCUS_HOLD_POLLS) return { pointer: hold.pointer, focus: false, focusPolls: 0, held: hold.pointer };
  return { pointer: hold.pointer, focus: true, focusPolls: hold.focusPolls + 1, held: true };
}

type BoardSnap = { window: string; items: { chain: string; token: string }[] };

/**
 * What a hold may keep is the order, nothing else. It gives way when the window changed or a shown token is no longer
 * ranked: the label ("Leading", "Last hour") and that card's figures would then describe something that is not so,
 * for as long as the mouse rests. A newcomer waits for the release, since every card on screen is still true. An
 * empty board has no order to keep (and no card for the mouse to leave), so it never holds.
 */
export function sameBoard(shown: BoardSnap, next: BoardSnap): boolean {
  if (shown.window !== next.window || shown.items.length === 0) return false;
  const ranked = new Set(next.items.map(launchKey));
  return shown.items.every((row) => ranked.has(launchKey(row)));
}

/** The change chip in words, for a screen reader: "up 27% since launch", "down 3.4% since launch", "up 19.7× since launch". */
export function changeWords(change: number): string {
  const { label, direction } = marketChange(change);
  if (label === "—") return "change since launch unknown";
  if (direction === "flat") return "unchanged since launch";
  return `${direction} ${label.replace(/^[+-]/, "")} since launch`;
}
