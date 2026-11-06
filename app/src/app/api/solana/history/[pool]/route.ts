import { PublicKey } from "@solana/web3.js";
import {
  fetchPoolSnapshot,
  PoolStateError,
  type PoolSnapshot,
} from "../../../../../../packages/solana-sdk/src/accounts";
import { publicKey } from "@/lib/solana/config";
import {
  createHistoryCache,
  fetchRecentSolanaHistory,
  type SolanaHistory,
} from "@/lib/solana/history";
import { configuredSolana, solanaConnection } from "@/lib/solana/server";
import { clientIp } from "@/lib/profiles/http";
import { rateLimited } from "@/lib/launchpad/editServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const cached = createHistoryCache<SolanaHistory>();
const GENESIS = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};
const noStore = { "cache-control": "no-store" };
/** The checked cluster, so a history request does not re-read the genesis hash every time. */
let network: { cluster: string; until: number } | null = null;
/** Shared pool reads: many viewers of one pool cost one snapshot read every few seconds, not one each. */
const snapshots = new Map<string, { until: number; read: Promise<PoolSnapshot> }>();
/** Addresses with no active pool, remembered briefly so a repeated lookup costs no RPC call. */
const absent = new Map<string, number>();
const NO_POOL = "NO_ACTIVE_POOL";

function snapshotFor(key: string, read: () => Promise<PoolSnapshot>) {
  const now = Date.now();
  const found = snapshots.get(key);
  if (found && found.until > now) return found.read;
  if (snapshots.size >= 256)
    for (const [id, entry] of snapshots)
      if (entry.until <= now) snapshots.delete(id);
  if (snapshots.size >= 256) snapshots.delete(snapshots.keys().next().value!);
  const entry = { until: now + 5_000, read: read() };
  snapshots.set(key, entry);
  // A failed read is not reused.
  entry.read.catch(() => {
    if (snapshots.get(key) === entry) snapshots.delete(key);
  });
  return entry.read;
}

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
  // The shared helper keys on Fly's client IP or the last forwarded hop: a spoofed header never buys a fresh bucket.
  if (rateLimited(`solana-history:${clientIp(req).slice(0, 64)}`, 30))
    return Response.json(
      { error: "Please wait before refreshing history." },
      { status: 429, headers: { ...noStore, "retry-after": "15" } },
    );
  const key = `${config.cluster}:${config.programId}:${pool}`;
  if ((absent.get(key) ?? 0) > Date.now())
    return Response.json(
      { error: "No active pool at this address." },
      { status: 404, headers: noStore },
    );
  try {
    const connection = solanaConnection();
    if (
      !network ||
      network.cluster !== config.cluster ||
      network.until < Date.now()
    ) {
      if ((await connection.getGenesisHash()) !== GENESIS[config.cluster])
        throw new Error("Wrong RPC cluster");
      network = { cluster: config.cluster, until: Date.now() + 60_000 };
    }
    // The pool is read before the history budget is charged: an address with no active pool costs one cheap read
    // and nothing from the shared allowance, so made-up addresses cannot crowd out real pools.
    const snapshot = await snapshotFor(key, () =>
      fetchPoolSnapshot(
        connection,
        new PublicKey(config.programId),
        new PublicKey(pool),
      ),
    ).catch((error: unknown) => {
      throw error instanceof PoolStateError ? new Error(NO_POOL) : error;
    });
    if (snapshot.pool.status !== "active") throw new Error(NO_POOL);
    const history = await cached(`${key}:${snapshot.pool.sequence}`, () =>
      fetchRecentSolanaHistory(
        connection,
        new PublicKey(config.programId),
        snapshot,
      ),
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
    const reason = error instanceof Error ? error.message : "";
    if (reason === NO_POOL) {
      if (absent.size >= 5_000) absent.clear();
      absent.set(key, Date.now() + 60_000);
      return Response.json(
        { error: "No active pool at this address." },
        { status: 404, headers: noStore },
      );
    }
    if (reason === "Wrong RPC cluster") network = null;
    const busy = reason === "HISTORY_BUSY";
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
