import "server-only";
import { addressKey } from "@/lib/addressKey";

/**
 * What a Boosted-lane click is counted once per 30 minutes for: the client's address alone, never its user agent
 * (which the caller picks, so one address could otherwise pass for a new visitor on every request). The address is
 * keyed as in addressKey: IPv4 as itself, IPv4-mapped IPv6 as its IPv4 address, any other IPv6 by its /64.
 *
 * People behind one shared address (an office, a mobile carrier) count once per 30 minutes: the public count leans
 * low rather than high. Server-only (node:net); the lane's client code never needs it.
 */
export function boostClickAddress(ip: string): string {
  return addressKey(ip);
}
