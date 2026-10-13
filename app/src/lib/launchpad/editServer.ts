import "server-only";
import { randomBytes } from "node:crypto";
import { isAddress, type Address, type Hex } from "viem";
import { publicClient } from "@/lib/chain";
import { chainIdOf, type ChainKey } from "@/lib/chainPublic";
import { maybeDb } from "@/lib/db";
import { EDIT_TTL_MS, buildEditMessage, isNonce, validateEdit, type EditFields } from "./editAuth";

/**
 * Server half of signed edits. The signature is verified with viem against the
 * token's chain (handles EOAs, ERC-1271 smart wallets and ERC-6492 pre-deploy
 * wallets), the nonce is single-use with a 5-minute TTL, and the signer must
 * be the launcher recorded from the on-chain Launched event.
 */
const buckets = new Map<string, { n: number; at: number }>();
/** Sliding limit: `max` hits per `windowMs` per key (wallet or ip). */
export function rateLimited(key: string, max = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.at > windowMs) {
    buckets.set(key, { n: 1, at: now });
    if (buckets.size > 20_000) buckets.clear();
    return false;
  }
  b.n += 1;
  return b.n > max;
}

export async function issueNonce(chain: ChainKey, token: string, wallet: string): Promise<{ nonce: string; expiresAt: number } | null> {
  const db = maybeDb();
  if (!db) return null;
  const launcher = await db<{ launcher: string }[]>`SELECT launcher FROM bb_launches WHERE chain_id = ${chainIdOf(chain)} AND token = ${token.toLowerCase()}`;
  if (!launcher[0] || launcher[0].launcher !== wallet.toLowerCase()) return null; // only the creator gets a nonce
  // No wallet rate limit here: the nonce endpoint is unauthenticated (no
  // signature), so the launcher check only confirms the supplied wallet
  // matches the public on-chain launcher address. An attacker who knows that
  // address could spend a wallet-keyed bucket by passing the launcher check.
  // The IP rate limit in the route is the only limit on this endpoint.
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + EDIT_TTL_MS;
  await db`INSERT INTO bb_edit_nonces (nonce, chain_id, token, wallet, expires_at) VALUES (${nonce}, ${chainIdOf(chain)}, ${token.toLowerCase()}, ${wallet.toLowerCase()}, ${new Date(expiresAt).toISOString()})`;
  void db`DELETE FROM bb_edit_nonces WHERE expires_at < now() - interval '1 hour'`.catch(() => {});
  return { nonce, expiresAt };
}

export type EditRequest = { chain: ChainKey; token: string; wallet: string; nonce: unknown; expiresAt: unknown; signature: unknown; fields: Partial<Record<keyof EditFields, unknown>> };

export async function applySignedEdit(r: EditRequest): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const db = maybeDb();
  if (!db) return { ok: false, error: "db unconfigured", status: 503 };
  if (!isAddress(r.wallet) || !isAddress(r.token)) return { ok: false, error: "bad address", status: 400 };
  if (!isNonce(r.nonce)) return { ok: false, error: "bad nonce", status: 400 };
  const expiresAt = Number(r.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return { ok: false, error: "expired", status: 400 };
  if (typeof r.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(r.signature)) return { ok: false, error: "bad signature", status: 400 };
  const v = validateEdit(r.fields);
  if (!v.ok) return { ok: false, error: v.error, status: 400 };
  const cid = chainIdOf(r.chain);
  const token = r.token.toLowerCase();
  const wallet = r.wallet.toLowerCase();

  // signer must be the on-chain launcher (checked before the nonce is spent,
  // so a non-creator does not burn a nonce they should not have)
  const row = await db<{ launcher: string; name: string; symbol: string }[]>`SELECT launcher, name, symbol FROM bb_launches WHERE chain_id = ${cid} AND token = ${token}`;
  if (!row[0] || row[0].launcher !== wallet) return { ok: false, error: "not the creator", status: 403 };

  // verify the signature before consuming the nonce: an RPC blip or a bad
  // signature must not burn the nonce (otherwise the creator cannot retry
  // with the same nonce and, combined with the wallet rate limit, can be
  // locked out of edits entirely)
  const message = buildEditMessage({ chain: r.chain, token, wallet, nonce: r.nonce, expiresAt, fields: v.value });
  let valid = false;
  try {
    valid = await publicClient(r.chain).verifyMessage({ address: wallet as Address, message, signature: r.signature as Hex });
  } catch {
    return { ok: false, error: "signature verification unavailable, try again", status: 503 };
  }
  if (!valid) {
    // viem's verifyMessage returns false (rather than throwing) when the RPC
    // transport is unreachable, so an outage would otherwise look like an
    // invalid signature (401). Probe liveness to tell an outage (503) from a
    // genuine mismatch (401); the nonce is still intact either way.
    try {
      await publicClient(r.chain).getChainId();
    } catch {
      return { ok: false, error: "signature verification unavailable, try again", status: 503 };
    }
    return { ok: false, error: "signature does not match", status: 401 };
  }

  // wallet rate limit is applied AFTER the signature is verified, so an
  // attacker cannot freeze a creator's edit budget by sending requests with
  // the creator's public address (the wallet is proven before the bucket is spent)
  if (rateLimited(`edit:wallet:${wallet}`, 10)) return { ok: false, error: "slow down", status: 429 };

  // nonce: exists, matches, unexpired, unused — consumed atomically, only
  // after the signature is proven, inside a transaction with the metadata
  // write so a failed INSERT rolls the nonce back
  const result = await db.begin(async (tx) => {
    const t = tx as unknown as NonNullable<ReturnType<typeof maybeDb>>;
    const nonce = r.nonce as string;
    const consumed = await t<{ nonce: string }[]>`
      UPDATE bb_edit_nonces SET used_at = now()
       WHERE nonce = ${nonce} AND chain_id = ${cid} AND token = ${token} AND wallet = ${wallet} AND used_at IS NULL AND expires_at > now()
         AND expires_at = ${new Date(expiresAt).toISOString()}
       RETURNING nonce`;
    if (consumed.length === 0) return { ok: false as const, error: "nonce invalid or already used", status: 401 };
    await t`
      INSERT INTO bb_launch_meta (chain_id, token, launcher, name, symbol, description, image_url, banner_url, website, x_handle, updated_at)
      VALUES (${cid}, ${token}, ${wallet}, ${row[0].name}, ${row[0].symbol}, ${v.value.description || null}, ${v.value.image_url || null}, ${v.value.banner_url || null}, ${v.value.website || null}, ${v.value.x_handle || null}, now())
      ON CONFLICT (chain_id, token) DO UPDATE SET description = EXCLUDED.description, image_url = EXCLUDED.image_url, banner_url = EXCLUDED.banner_url, website = EXCLUDED.website, x_handle = EXCLUDED.x_handle, updated_at = now()`;
    return { ok: true as const };
  });
  return result;
}
