import "server-only";
import { isIP } from "node:net";

/**
 * What a Boosted-lane click is counted once per 30 minutes for: the client's address alone, never its user agent
 * (which the caller picks, so one address could otherwise pass for a new visitor on every request).
 *
 * - IPv4: the address.
 * - IPv4-mapped IPv6 (::ffff:0:0/96, written dotted as ::ffff:203.0.113.7 or in hex as ::ffff:cb00:7107): its IPv4
 *   address, so every IPv4 client keeps its own key.
 * - Any other IPv6: its /64, the block one home or phone is given, so moving inside it buys nothing.
 * - Anything node:net does not take for an address: itself, as its own key.
 *
 * People behind one shared address (an office, a mobile carrier) count once per 30 minutes: the public count leans
 * low rather than high. Server-only (node:net); the lane's client code never needs it.
 */
export function boostClickAddress(ip: string): string {
  const a = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const kind = isIP(a);
  if (kind !== 6) return a;
  const g = ipv6Groups(a);
  if (!g) return a;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** A valid IPv6 address (isIP said so) as its eight 16-bit groups; a dotted IPv4 tail becomes the last two. */
function ipv6Groups(a: string): number[] | null {
  let s = a;
  const dotted = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [b0, b1, b2, b3] = dotted.slice(1, 5).map(Number);
    s = `${s.slice(0, dotted.index)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((x) => parseInt(x, 16));
  return groups.length === 8 && groups.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? groups : null;
}
