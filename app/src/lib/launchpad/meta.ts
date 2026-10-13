import { canonicalImageUrl } from "./images";
import { imagePublicBase } from "./imageStore";
import "server-only";
import { type Address } from "viem";
import { publicClient } from "@/lib/chain";
import { chainIdOf, type ChainKey } from "@/lib/chainPublic";
import { maybeDb } from "@/lib/db";
import { LAUNCH_FACTORY_ABI } from "./abi";
import { DEFAULT_SUPPLY, launchpad } from "./config";

/**
 * Off-chain launch metadata. The form stores it BEFORE sending the launch tx,
 * keyed by the token address the factory will produce (predictToken is a pure
 * view), and passes `metadataURI = ${SITE_URL}/api/launch/meta/<token>` on-chain.
 * If the tx never lands the row is harmless (no launch row joins to it).
 */
export { LIMITS, validateMeta, metaUriFor, type MetaInput } from "./metaShared";
import { metaUriFor as uriFor, metaWriteDecision, type MetaInput as Input, type MetaRow } from "./metaShared";

/** Predict the token address for these params (metadataURI is part of the CREATE2 init hash, so it must be the final URI). */
export async function predictToken(m: Input, uri: string): Promise<Address> {
  const factory = launchpad(m.chain).factory;
  if (!factory) throw new Error(`launchpad unconfigured on ${m.chain}`);
  return publicClient(m.chain).readContract({
    address: factory,
    abi: LAUNCH_FACTORY_ABI,
    functionName: "predictToken",
    args: [m.launcher as Address, m.salt, m.name, m.symbol, DEFAULT_SUPPLY, uri],
  });
}

export class MetaConflict extends Error {
  status = 409;
}

/**
 * Register metadata for a launch about to be sent. INSERT-only for unsigned callers (see
 * metaWriteDecision): the creator writes while the salt is still private; replays of the public
 * launch params cannot overwrite. Returns the stable URI (keyed by meta_key) and the predicted token.
 */
export async function saveMeta(m: Input): Promise<{ uri: string; token: Address }> {
  const pool = maybeDb();
  if (!pool) throw new Error("db unconfigured");
  const uri = uriFor(m.launcher, m.meta_key);
  const token = (await predictToken(m, uri)).toLowerCase() as Address;
  const cid = chainIdOf(m.chain);
  const launcher = m.launcher.toLowerCase();
  // Ownership is per (chain, launcher, meta_key) — the thing the public URI is keyed by — not just per
  // token row: the salt search legitimately registers several token rows under one key, but they must
  // all carry the content the FIRST registration set. Serialized with a transaction-scoped advisory
  // lock so two concurrent first writes cannot both win.
  return pool.begin(async (tx) => {
    const db = tx as unknown as NonNullable<ReturnType<typeof maybeDb>>;
    await db`SELECT pg_advisory_xact_lock(hashtext(${`meta:${cid}:${launcher}:${m.meta_key}`}))`;
    const [owner] = await db<MetaRow[]>`
      SELECT launcher, name, symbol, description, image_url, banner_url, website, x_handle FROM bb_launch_meta
       WHERE chain_id = ${cid} AND launcher = ${launcher} AND meta_key = ${m.meta_key}
       ORDER BY created_at ASC, token ASC LIMIT 1`;
    if (owner && metaWriteDecision(owner, m) === "conflict") throw new MetaConflict("this metadata key is already registered with different details. Edit after launch from your dashboard, or start a new launch");
    const inserted = await db`
      INSERT INTO bb_launch_meta (chain_id, token, launcher, meta_key, name, symbol, description, image_url, banner_url, website, x_handle)
      VALUES (${cid}, ${token}, ${launcher}, ${m.meta_key}, ${m.name}, ${m.symbol}, ${m.description ?? null}, ${m.image_url ?? null}, ${m.banner_url ?? null}, ${m.website ?? null}, ${m.x_handle ?? null})
      ON CONFLICT (chain_id, token) DO NOTHING RETURNING token`;
    if (inserted.length === 0) {
      const [existing] = await db<MetaRow[]>`SELECT launcher, name, symbol, description, image_url, banner_url, website, x_handle FROM bb_launch_meta WHERE chain_id = ${cid} AND token = ${token}`;
      if (metaWriteDecision(existing ?? null, m) === "conflict") throw new MetaConflict("metadata for this launch is already registered. Edit it after launch from your dashboard, or pick a new salt");
    }
    return { uri, token };
  }) as Promise<{ uri: string; token: Address }>;
}

export type MetaJson = { name: string; symbol: string; description?: string; image?: string; banner?: string; external_url?: string; x?: string; token?: string };

export async function readMeta(where: { chain?: ChainKey; token?: string; launcher?: string; key?: string }): Promise<MetaJson | null> {
  const db = maybeDb();
  if (!db) return null;
  const chainCond = where.chain ? db`AND m.chain_id = ${chainIdOf(where.chain)}` : db``;
  const rows = where.token
    ? await db<{ token: string; name: string; symbol: string; description: string | null; image_url: string | null; banner_url: string | null; website: string | null; x_handle: string | null }[]>`
        SELECT m.token, m.name, m.symbol, m.description, m.image_url, m.banner_url, m.website, m.x_handle FROM bb_launch_meta m WHERE m.token = ${where.token.toLowerCase()} ${chainCond} ORDER BY m.created_at DESC LIMIT 1`
    : await db<{ token: string; name: string; symbol: string; description: string | null; image_url: string | null; banner_url: string | null; website: string | null; x_handle: string | null }[]>`
        SELECT m.token, m.name, m.symbol, m.description, m.image_url, m.banner_url, m.website, m.x_handle FROM bb_launch_meta m
        LEFT JOIN bb_launches l ON l.chain_id = m.chain_id AND l.token = m.token
        WHERE m.launcher = ${(where.launcher ?? "").toLowerCase()}
          AND (m.meta_key = ${(where.key ?? "").toLowerCase()} OR l.metadata_uri = ${uriFor(where.launcher ?? "", where.key ?? "0x")})
        ORDER BY (l.token IS NOT NULL) DESC, m.created_at ASC, m.token ASC LIMIT 1`; // the launched row wins; before indexing, the FIRST registration under the key (never a later one)
  const r = rows[0];
  if (!r) return null;
  return { name: r.name, symbol: r.symbol, description: r.description ?? undefined, image: canonicalImageUrl(r.image_url, imagePublicBase()) ?? undefined, banner: canonicalImageUrl(r.banner_url, imagePublicBase()) ?? undefined, external_url: r.website ?? undefined, x: r.x_handle ?? undefined, token: r.token };
}
