import type { MetadataRoute } from "next";
import { CHAIN_IDS, CHAIN_KEYS, SITE_URL, chainKeyOf } from "@/lib/chainPublic";
import { maybeDb } from "@/lib/db";
import { CONFIGURED_CHAINS } from "@/lib/launchpad/config";
import { staticSitemapEntries, tokenSitemapEntries, type TokenRow } from "@/lib/seo";

// Rendered per request like the rest of the app: the token list must not be
// frozen at build time (CI builds without DATABASE_URL, which would leave only
// the static routes forever).
export const dynamic = "force-dynamic";

/**
 * Sitemap: static routes plus the newest launches (fail-soft).
 * The DB is an index of the chain (see db/schema.sql); when it is
 * unconfigured or unreachable we still serve the static routes so
 * crawlers always get a valid sitemap instead of a 500.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const statics = staticSitemapEntries(SITE_URL, undefined, CONFIGURED_CHAINS);
  let tokens: TokenRow[] = [];
  try {
    const sql = maybeDb();
    if (sql) {
      const rows = (await sql`
        SELECT chain_id, token, block_time
        FROM bb_launches
        WHERE chain_id IN ${sql(CHAIN_KEYS.map((k) => CHAIN_IDS[k]))}
        ORDER BY block_time DESC
        LIMIT 1000
      `) as unknown as { chain_id: number; token: string; block_time: string | null }[];
      tokens = rows.flatMap((r) => {
        const chain = chainKeyOf(r.chain_id);
        const token = String(r.token ?? "").toLowerCase();
        return chain && /^0x[0-9a-f]{40}$/.test(token) ? [{ chain, token, block_time: r.block_time }] : [];
      });
    }
  } catch {
    tokens = [];
  }
  return [...statics, ...tokenSitemapEntries(SITE_URL, tokens)];
}
