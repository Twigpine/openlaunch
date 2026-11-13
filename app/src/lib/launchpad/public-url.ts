/**
 * Browser-safe metadata URL policy shared by initial creation and signed edits.
 * Reject local/special IP literals and local host names. This does not resolve DNS or
 * inspect redirects, and is not a server-side SSRF boundary. Server image fetches must
 * still use the separate owned-image policy.
 */
export const METADATA_URL_MAX = 300;

function publicV4([a, b, c]: number[]): boolean {
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

function publicV6(host: string): boolean {
  // URL already validated/canonicalized the literal, including dotted IPv4 tails.
  const [left, right] = host.slice(1, -1).split("::");
  const before = left ? left.split(":").map((x) => Number.parseInt(x, 16)) : [];
  const after = right ? right.split(":").map((x) => Number.parseInt(x, 16)) : [];
  const words = right === undefined ? before : [...before, ...Array<number>(8 - before.length - after.length).fill(0), ...after];
  if (words.length !== 8 || words.some((x) => !Number.isInteger(x))) return false;
  const v4 = (i: number) => publicV4([words[i] >>> 8, words[i] & 255, words[i + 1] >>> 8, words[i + 1] & 255]);
  // IPv4-mapped/translated and well-known NAT64 addresses must not hide a local IPv4.
  if (words.slice(0, 5).every((x) => x === 0) && words[5] === 0xffff) return v4(6);
  if (words.slice(0, 4).every((x) => x === 0) && words[4] === 0xffff && words[5] === 0) return v4(6);
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((x) => x === 0)) return v4(6);
  // Only global unicast space; excludes unspecified, loopback, ULA, link/site-local,
  // multicast, discard-only and locally assigned translation prefixes.
  if ((words[0] & 0xe000) !== 0x2000) return false;
  // Protocol-assignment/documentation ranges are not metadata destinations.
  if (words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) return false;
  if (words[0] === 0x3fff && words[1] < 0x1000) return false;
  if (words[0] === 0x2002) return v4(1); // legacy 6to4 embeds the IPv4 gateway
  return true;
}

/** Undefined means unset; null means invalid. Never truncate into a different URL. */
export function publicHttpsUrl(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > METADATA_URL_MAX) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (host.startsWith("[")) {
      if (!publicV6(host)) return null;
    } else if (/^\d+(\.\d+){3}$/.test(host)) {
      if (!publicV4(host.split(".").map(Number))) return null;
    } else if (!host.includes(".") || /(^|\.)(localhost|local|localdomain|internal|lan)$/.test(host) || /(^|\.)home\.arpa$/.test(host)) {
      return null;
    }
    const normalized = url.toString();
    return normalized.length <= METADATA_URL_MAX ? normalized : null;
  } catch {
    return null;
  }
}
