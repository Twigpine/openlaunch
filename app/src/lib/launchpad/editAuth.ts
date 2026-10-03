/**
 * Signed-edit protocol for off-chain token metadata (pure parts; node --test loads this).
 *
 *   1. client asks for a nonce for (chain, token, wallet)            → server stores {nonce, expiresAt}, single use
 *   2. client signs `buildEditMessage(...)` with the wallet           (EIP-191 personal_sign; smart wallets via ERC-1271)
 *   3. client POSTs the edit + nonce + signature                      → server verifies signature, nonce, expiry,
 *                                                                        and that the signer is the on-chain launcher
 */
import { parseXHandle } from "./xHandle.ts";

export const EDIT_TTL_MS = 5 * 60_000;
export const EDIT_DOMAIN = "openlaunch.lol";

export type EditFields = { description?: string; image_url?: string; website?: string; x_handle?: string };

export function buildEditMessage(p: { chain: string; token: string; wallet: string; nonce: string; expiresAt: number; fields: EditFields }): string {
  const lines = [
    `${EDIT_DOMAIN} wants you to update token details.`,
    ``,
    `Chain: ${p.chain}`,
    `Token: ${p.token.toLowerCase()}`,
    `Wallet: ${p.wallet.toLowerCase()}`,
    `Nonce: ${p.nonce}`,
    `Expires: ${new Date(p.expiresAt).toISOString()}`,
    ``,
    `Changes:`,
    `description: ${p.fields.description ?? ""}`,
    `image: ${p.fields.image_url ?? ""}`,
    `website: ${p.fields.website ?? ""}`,
    `x: ${p.fields.x_handle ?? ""}`,
    ``,
    `This only changes off-chain details on ${EDIT_DOMAIN}. It costs nothing and moves no funds.`,
  ];
  return lines.join("\n");
}

export function isNonce(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
}

/** Validate edit fields; returns normalized fields or an error. Mirrors the launch form rules. */
export function validateEdit(f: Partial<Record<keyof EditFields, unknown>>): { ok: true; value: EditFields } | { ok: false; error: string } {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const description = str(f.description, 280);
  const url = (v: unknown) => {
    const s = str(v, 300);
    if (!s) return "";
    try {
      const u = new URL(s);
      if (u.protocol !== "https:") return null;
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(u.hostname)) return null;
      return u.toString();
    } catch {
      return null;
    }
  };
  const image_url = url(f.image_url);
  const website = url(f.website);
  if (image_url === null) return { ok: false, error: "image: https URL only" };
  if (website === null) return { ok: false, error: "website: https URL only" };
  const x = parseXHandle(f.x_handle);
  if (!x.ok) return { ok: false, error: x.error };
  const x_handle = x.handle;
  if (/<[a-z!/]/i.test(description)) return { ok: false, error: "description: no HTML" };
  return { ok: true, value: { description, image_url, website, x_handle } };
}
