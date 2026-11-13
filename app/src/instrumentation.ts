/**
 * Next.js instrumentation hook — runs once per server process at boot.
 * Starts the in-process launchpad indexer (src/lib/launchpad/loop.ts) when
 * LAUNCH_SYNC_LOOP=1 (set in fly.toml [env]), and ends the admin sessions of
 * wallets no longer in ADMIN_WALLETS. Node runtime only.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // a change to ADMIN_WALLETS restarts the machines: end, for good, the sessions of any wallet it no longer lists
  if (process.env.DATABASE_URL) {
    const { revokeNonAdminSessions } = await import("./lib/admin/session");
    void revokeNonAdminSessions()
      .then((n) => (n ? console.info(`[admin] ended ${n} session(s) of wallets no longer in ADMIN_WALLETS`) : undefined))
      .catch((err) => console.error("[admin] session sweep failed:", err instanceof Error ? err.message : err));
  }
  if (process.env.LAUNCH_SYNC_LOOP === "1") {
    const { startLaunchSyncLoop } = await import("./lib/launchpad/loop");
    startLaunchSyncLoop();
  }
}
