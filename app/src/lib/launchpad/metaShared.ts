/**
 * Launch metadata — the pure half (node --test loads this; meta.ts adds the DB/RPC half).
 *
 * Two keys, on purpose:
 *   - `salt`     is the CREATE2 salt the factory ends up using. It can CHANGE: for ERC-20 quotes the
 *                factory searches for a salt whose token sorts above the quote (findSalt).
 *   - `meta_key` is chosen once by the client and never changes. The on-chain metadataURI is built
 *                from it — so the URI, and therefore the CREATE2 init-code hash, is stable while
 *                the salt search runs. (Keying the URI by the salt broke ~1 in 10 USDG/stock launches.)
 */
import { isAddress, type Hex } from "viem";
import { SITE_URL, isChainKey, type ChainKey, CHAIN_KEY_PATTERN } from "../chainPublic.ts";
import { parseXHandle } from "./xHandle.ts";

export type MetaInput = { chain: ChainKey; launcher: string; salt: Hex; meta_key: Hex; name: string; symbol: string; description?: string; image_url?: string; website?: string; x_handle?: string };
export const LIMITS = { name: 32, symbol: 10, description: 280 } as const;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export function validateMeta(m: Partial<MetaInput> & { meta_key?: string }): { ok: true; value: MetaInput } | { ok: false; error: string } {
  const name = (m.name ?? "").trim();
  const symbol = (m.symbol ?? "").trim().toUpperCase();
  if (!name || name.length > LIMITS.name) return { ok: false, error: `name: 1–${LIMITS.name} characters` };
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) return { ok: false, error: "symbol: 1–10 letters or digits" };
  if (!isChainKey(m.chain)) return { ok: false, error: `chain: ${CHAIN_KEY_PATTERN.replace(/\|/g, " | ")}` };
  if (!m.launcher || !isAddress(m.launcher)) return { ok: false, error: "launcher: bad address" };
  if (!m.salt || !BYTES32.test(m.salt)) return { ok: false, error: "salt: bad bytes32" };
  const meta_key = (m.meta_key ?? m.salt) as Hex; // older clients: the salt doubles as the key
  if (!BYTES32.test(meta_key)) return { ok: false, error: "meta_key: bad bytes32" };
  const description = (m.description ?? "").trim().slice(0, LIMITS.description) || undefined;
  const url = (v?: string) => {
    const s = (v ?? "").trim();
    if (!s) return undefined;
    try {
      const u = new URL(s);
      if (u.protocol !== "https:") return null;
      return u.toString().slice(0, 300);
    } catch {
      return null;
    }
  };
  const image_url = url(m.image_url);
  const website = url(m.website);
  if (image_url === null) return { ok: false, error: "image: https URL only" };
  if (website === null) return { ok: false, error: "website: https URL only" };
  const x = parseXHandle(m.x_handle);
  if (!x.ok) return { ok: false, error: x.error };
  const x_handle = x.handle || undefined;
  return { ok: true, value: { chain: m.chain, launcher: m.launcher, salt: m.salt as Hex, meta_key: meta_key.toLowerCase() as Hex, name, symbol, description, image_url, website, x_handle } };
}

/** The on-chain metadataURI: keyed by (launcher, meta_key) — stable across the salt search. */
export function metaUriFor(launcher: string, metaKey: string): string {
  return `${SITE_URL}/api/launch/meta/${launcher.toLowerCase()}/${metaKey.toLowerCase()}`;
}

export type MetaRow = { launcher: string; name: string; symbol: string; description: string | null; image_url: string | null; website: string | null; x_handle: string | null };

/**
 * Unsigned writes are INSERT-only. The creator registers before broadcasting, while the salt is
 * still private, so they always own the row; anyone replaying the public launch params afterwards
 * gets "conflict". An identical re-send (double click, retry) is "same" and succeeds idempotently.
 * Changes after launch go through the wallet-signed edit flow.
 */
export function metaWriteDecision(existing: MetaRow | null, incoming: MetaInput): "insert" | "same" | "conflict" {
  if (!existing) return "insert";
  const same =
    existing.launcher.toLowerCase() === incoming.launcher.toLowerCase() &&
    existing.name === incoming.name &&
    existing.symbol === incoming.symbol &&
    (existing.description ?? null) === (incoming.description ?? null) &&
    (existing.image_url ?? null) === (incoming.image_url ?? null) &&
    (existing.website ?? null) === (incoming.website ?? null) &&
    (existing.x_handle ?? null) === (incoming.x_handle ?? null);
  return same ? "same" : "conflict";
}
