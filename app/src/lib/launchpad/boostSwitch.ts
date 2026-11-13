import "server-only";

/**
 * The BOOST runtime switch (`fly secrets set BOOST=on`, which restarts the app; no rebuild). Its own module so the
 * totals query can ask it without importing the lane's server half. Anything else, or unset, is off.
 */
export function boostEnabled(): boolean {
  return process.env.BOOST?.trim().toLowerCase() === "on";
}
