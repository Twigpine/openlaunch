import type { Address } from "viem";

/**
 * MUSEWORLD: Museworld's token (museworld.lol), an official quote. It is not offered in the launch form: launches
 * paired with it are made inside Museworld, by its AI agents, straight against the factory. Here it is listed so those
 * launches carry the Museworld badge and a USD price instead of showing as an unlisted pair (unlisted-quote.ts).
 *
 * MUSEWORLD was itself launched on openlaunch, paired with GITLAWB, and that pool is its deepest market. So its price
 * needs no new feed: GITLAWB per MUSEWORLD from our own index of that pool, times GITLAWB's USD price. That leg is
 * checked against a 30-minute time-weighted average (`timeWeightedPrice`), so one swap that pushes the pool for a block
 * cannot rewrite the market caps, volumes or rankings of every MUSEWORLD-paired launch. Client-safe; pure.
 */
export const MUSEWORLD_ADDRESS = "0x882c8e35504d58979b1280fe76d6553f717029f8" as Address; // Base
export const MUSEWORLD_SYMBOL = "MUSEWORLD";
export const MUSEWORLD_NAME = "Museworld";
export const MUSEWORLD_DECIMALS = 18;
export const MUSEWORLD_SITE = "https://museworld.lol";
/** The white "m" and sparkle on Museworld blue, as a 160px rounded tile (from the Museworld repo's DexScreener icon). */
export const MUSEWORLD_LOGO_PATH = "/museworld-mark.png";
/** The tile's ground: badges use the same blue so the tile and the pill read as one piece. */
export const MUSEWORLD_BLUE = "#0866FF";
/** Window of the time-weighted price. */
export const MUSEWORLD_TWAP_WINDOW_S = 30 * 60;

/**
 * Time-weighted average of a step price over [from, to] (unix seconds). The pool price is a step function: `baseline`
 * holds from `from` until the first point, and each point's price holds until the next one. Without a baseline the
 * window starts at the first point. null when there is nothing to average or an input is unusable.
 */
export function timeWeightedPrice(points: { t: number; price: number }[], baseline: number | null, from: number, to: number): number | null {
  if (!(to > from)) return null;
  const steps = points.filter((p) => Number.isFinite(p.price) && p.price > 0 && p.t <= to).sort((a, b) => a.t - b.t);
  let level = baseline !== null && Number.isFinite(baseline) && baseline > 0 ? baseline : null;
  let at = from;
  let area = 0;
  let span = 0;
  for (const p of steps) {
    const t = Math.max(p.t, from);
    if (level !== null && t > at) {
      area += level * (t - at);
      span += t - at;
    }
    level = p.price;
    at = t;
  }
  if (level !== null && to > at) {
    area += level * (to - at);
    span += to - at;
  }
  return span > 0 ? area / span : null;
}
