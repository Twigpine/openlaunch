/** Signed admin messages for season points (pure; node --test loads this directly). */
export const POINTS_ADMIN_ACTIONS = ["preview", "start", "publish", "unpublish", "end", "recompute"] as const;
export type PointsAdminAction = (typeof POINTS_ADMIN_ACTIONS)[number];
export function isPointsAdminAction(v: unknown): v is PointsAdminAction {
  return typeof v === "string" && (POINTS_ADMIN_ACTIONS as readonly string[]).includes(v);
}

export function buildPointsAdminMessage(p: { action: PointsAdminAction; wallet: string; nonce: string; ts: number }): string {
  return [`openlaunch.lol points`, ``, `Action: ${p.action}`, `Admin: ${p.wallet.toLowerCase()}`, `Nonce: ${p.nonce}`, `Issued: ${new Date(p.ts).toISOString()}`].join("\n");
}
