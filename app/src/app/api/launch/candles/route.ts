import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { isChainKey } from "@/lib/chainPublic";
import { getCandleBaseline, getCandles, getLaunch, getWalletSwaps } from "@/lib/launchpad/queries";
import { INTERVALS, boundedCandleFrom, isInterval } from "@/lib/launchpad/candles";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { memo } from "@/lib/launchpad/memo";

export const dynamic = "force-dynamic";

/**
 * GET /api/launch/candles?chain=&token=&interval=1m|5m|15m|1h|4h|1d[&from=unix][&wallet=0x…]
 * → { interval, from, asOf, baseline: {price, hasPriorTrades}, launch: {t, price}, quote: {symbol, decimals, usd}, supply, candles: RawCandle[], mine?: [...] }
 * Sparse whole buckets (quote per token), at most 2,000 including the current
 * bucket. The client fills gaps from baseline.price. 3s snapshot memo per key.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const chain = u.searchParams.get("chain");
  const token = (u.searchParams.get("token") ?? "").toLowerCase();
  const interval = u.searchParams.get("interval") ?? "5m";
  if (!isChainKey(chain) || !isAddress(token) || !isInterval(interval)) return NextResponse.json({ error: "bad params" }, { status: 400 });
  try {
    const usd = await ethUsd();
    const l = await memo(`launch:${chain}:${token}`, 3_000, () => getLaunch(chain, token, usd));
    if (!l) return NextResponse.json({ error: "not found" }, { status: 404 });
    // getLaunch resolves issuer-registry stock quotes too; the static quote list
    // would relabel them "?" and could aggregate with the wrong decimals.
    const q = { symbol: l.quote_symbol, decimals: l.quote_decimals };
    const intervalS = INTERVALS[interval];
    const launchT = Math.floor(new Date(l.block_time).getTime() / 1000);
    const requestedAt = Math.floor(Date.now() / 1000);
    const fromRaw = Number(u.searchParams.get("from"));
    const from = boundedCandleFrom(fromRaw, launchT, requestedAt, intervalS);
    const wallet = u.searchParams.get("wallet");
    const snapshot = await memo(`candles:${chain}:${token}:${interval}:${from}`, 3_000, async () => {
      const asOf = requestedAt;
      const [candles, priorPrice] = await Promise.all([
        getCandles(chain, token, intervalS, from, q.decimals, asOf),
        getCandleBaseline(chain, token, from, q.decimals),
      ]);
      return { candles, priorPrice, asOf };
    });
    // A cache hit can predate this request. Markers must share its cutoff so a
    // new wallet trade cannot appear ahead of the corresponding OHLCV update.
    const mine = wallet && isAddress(wallet) ? await getWalletSwaps(chain, token, wallet, snapshot.asOf) : null;
    // launch price in quote per token, from the start tick
    const launchPrice = 1 / (Math.pow(1.0001, l.start_tick) * Math.pow(10, q.decimals - 18));
    const baseline = { price: snapshot.priorPrice ?? launchPrice, hasPriorTrades: snapshot.priorPrice !== null };
    return NextResponse.json(
      { interval, from, asOf: snapshot.asOf, baseline, launch: { t: launchT, price: launchPrice }, quote: { symbol: q.symbol, decimals: q.decimals, usd: l.quote_usd }, supply: Number(BigInt(l.supply)) / 1e18, candles: snapshot.candles, mine },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("[launch] candles failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load candles" }, { status: 502 });
  }
}
