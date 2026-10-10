import { PublicKey } from "@solana/web3.js";
import { fetchPoolSnapshot } from "../../../../../../packages/solana-sdk/src/accounts";
import { publicKey } from "@/lib/solana/config";
import {
  createHistoryCache,
  fetchRecentSolanaHistory,
  type SolanaHistory,
} from "@/lib/solana/history";
import { configuredSolana, solanaConnection } from "@/lib/solana/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const cached = createHistoryCache<SolanaHistory>();
const buckets = new Map<string, { at: number; count: number }>();
const GENESIS = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};
const noStore = { "cache-control": "no-store" };

export async function GET(
  req: Request,
  { params }: { params: Promise<{ pool: string }> },
) {
  const config = configuredSolana();
  if (!config)
    return Response.json(
      { error: "Solana is not enabled." },
      { status: 503, headers: noStore },
    );
  const { pool } = await params;
  if (!publicKey(pool))
    return Response.json(
      { error: "Invalid pool address." },
      { status: 400, headers: noStore },
    );
  const ip = (
    req.headers.get("fly-client-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0] ??
    "local"
  ).slice(0, 128);
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (bucket && now - bucket.at < 60_000 && bucket.count >= 30)
    return Response.json(
      { error: "Please wait before refreshing history." },
      { status: 429, headers: { ...noStore, "retry-after": "15" } },
    );
  if (buckets.size >= 5000) buckets.clear();
  buckets.set(
    ip,
    bucket && now - bucket.at < 60_000
      ? { at: bucket.at, count: bucket.count + 1 }
      : { at: now, count: 1 },
  );
  try {
    const history = await cached(
      `${config.cluster}:${config.programId}:${pool}`,
      async () => {
        const connection = solanaConnection();
        if ((await connection.getGenesisHash()) !== GENESIS[config.cluster])
          throw new Error("Wrong RPC cluster");
        const snapshot = await fetchPoolSnapshot(
          connection,
          new PublicKey(config.programId),
          new PublicKey(pool),
        );
        return fetchRecentSolanaHistory(
          connection,
          new PublicKey(config.programId),
          snapshot,
        );
      },
    );
    return Response.json(
      { ...history, cluster: config.cluster },
      {
        headers: {
          "cache-control":
            "public, max-age=0, s-maxage=10, stale-while-revalidate=15",
        },
      },
    );
  } catch (error) {
    const busy = error instanceof Error && error.message === "HISTORY_BUSY";
    return Response.json(
      {
        error: busy
          ? "Recent history is busy. Please retry shortly."
          : "Verified recent history is unavailable. No chart data has been substituted.",
      },
      {
        status: busy ? 429 : 503,
        headers: { ...noStore, "retry-after": "15" },
      },
    );
  }
}
