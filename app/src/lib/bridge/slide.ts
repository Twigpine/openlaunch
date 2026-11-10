/**
 * Slide to confirm: the bridge deposit can be confirmed by dragging a coin across a rail. The rules are pure so the
 * component cannot drift from them: a deposit is requested only by a release (or Enter) at the far end, never by
 * movement alone, and anything short of that puts the coin back with nothing requested.
 */

/** How far across (0 to 1) the coin must be when let go for the release to count as a confirmation. */
export const SLIDE_CONFIRM_AT = 0.9;
const KEY_STEP = 0.1;

/** Coin position (0 to 1) for a pointer at `pointerX`, grabbed `grabOffset` px from the coin's left edge. */
export function slideProgress(pointerX: number, trackLeft: number, grabOffset: number, travel: number): number {
  if (!(travel > 0) || !Number.isFinite(pointerX)) return 0;
  return Math.min(1, Math.max(0, (pointerX - trackLeft - grabOffset) / travel));
}

/** Letting go confirms only at the far end; everywhere else it resets. */
export function slideRelease(progress: number): "confirm" | "reset" {
  return progress >= SLIDE_CONFIRM_AT ? "confirm" : "reset";
}

/**
 * Keyboard control. Arrows, Home and End only move the coin; Enter or Space confirm, and only once it is at the far
 * end. Null for any other key, which the browser then handles as usual.
 */
export function slideKey(progress: number, key: string): { progress: number; confirm: boolean } | null {
  const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10) / 10;
  if (key === "ArrowRight" || key === "ArrowUp") return { progress: round(progress + KEY_STEP), confirm: false };
  if (key === "ArrowLeft" || key === "ArrowDown") return { progress: round(progress - KEY_STEP), confirm: false };
  if (key === "Home") return { progress: 0, confirm: false };
  if (key === "End") return { progress: 1, confirm: false };
  if (key === "Enter" || key === " ") return { progress, confirm: slideRelease(progress) === "confirm" };
  return null;
}

/** Whole turns a coin `size` px wide makes rolling `travel` px, so it always comes to rest upright. */
export function slideTurns(travel: number, size: number): number {
  return Math.max(1, Math.round(travel / (Math.PI * size)));
}
