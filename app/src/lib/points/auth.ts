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

/**
 * The message an admin wallet signs for one points action. Starting a season also names its length, so a signed
 * request cannot be replayed with a different one.
 */
export function buildPointsAdminMessage(p: { action: PointsAdminAction; wallet: string; nonce: string; ts: number; days?: number }): string {
  return [
    `openlaunch.lol points`,
    ``,
    `Action: ${p.action}`,
    ...(p.action === "start" ? [`Season length: ${normalizeSeasonDays(p.days)} days`] : []),
    `Admin: ${p.wallet.toLowerCase()}`,
    `Nonce: ${p.nonce}`,
    `Issued: ${new Date(p.ts).toISOString()}`,
  ].join("\n");
}
