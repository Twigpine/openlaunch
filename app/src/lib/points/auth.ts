/** Signed admin messages for season points (pure; node --test loads this directly). */
export const POINTS_ADMIN_ACTIONS = ["preview", "start", "publish", "unpublish", "end", "recompute"] as const;
export type PointsAdminAction = (typeof POINTS_ADMIN_ACTIONS)[number];
/** One of the admin actions on the points season. */
export function isPointsAdminAction(v: unknown): v is PointsAdminAction {
  return typeof v === "string" && (POINTS_ADMIN_ACTIONS as readonly string[]).includes(v);
}

/** A season length as the server will use it: whole days, 1 to 90, 28 when missing or not a number. */
export function normalizeSeasonDays(raw: unknown): number {
  return Math.min(90, Math.max(1, Math.trunc(Number(raw) || 28)));
}

/** The actions that act on one named season (its id is signed with them). */
export const SEASON_ACTIONS: readonly PointsAdminAction[] = ["publish", "unpublish", "end"];
/** A season id as signed: a positive whole number, else 0 (no season). */
export function normalizeSeasonId(raw: unknown): number {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The message an admin wallet signs for one points action. Starting a season also names its length, and publish,
 * hide and end name the season they act on, so a signed request can be replayed with neither a different length
 * nor a different season.
 */
export function buildPointsAdminMessage(p: { action: PointsAdminAction; wallet: string; nonce: string; ts: number; days?: number; seasonId?: number }): string {
  return [
    `openlaunch.lol points`,
    ``,
    `Action: ${p.action}`,
    ...(p.action === "start" ? [`Season length: ${normalizeSeasonDays(p.days)} days`] : []),
    ...(SEASON_ACTIONS.includes(p.action) ? [`Season: ${normalizeSeasonId(p.seasonId)}`] : []),
    `Admin: ${p.wallet.toLowerCase()}`,
    `Nonce: ${p.nonce}`,
    `Issued: ${new Date(p.ts).toISOString()}`,
  ].join("\n");
}
