import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { isChainKey } from "@/lib/chainPublic";
import { maybeDb } from "@/lib/db";
import { getHolderPanel } from "@/lib/launchpad/holdersServer";
import { getSwaps } from "@/lib/launchpad/queries";
import { memo } from "@/lib/launchpad/memo";
import { chainIdOf } from "@/lib/chainPublic";

export const dynamic = "force-dynamic";

/** GET /api/launch/metrics?chain=base&token=0x… → per‑launch metrics (holders, trades, volume, fees). 30‑second memo per launch. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const chain = u.searchParams.get("chain");
  const token = u.searchParams.get("token");
  if (!isChainKey(chain) || !token || !isAddress(token)) return NextResponse.json({ error: "bad params" }, { status: 400 });
  try {
    const db = maybeDb();
    let quoteDecimals = 18;
    let feesCollectedRaw = 0;
    let feesBurnedRaw = 0;
    if (db) {
      // Grab the launch row so we have quote_decimals and fee totals.
      const launches = await db<{
        quote_decimals: number;
        fees_quote_collected: string;
        fees_quote_burned: string;
        supply: string;
      }[]>`
        SELECT quote_decimals,
               fees_quote_collected,
               fees_quote_burned,
               supply::text AS supply
        FROM bb_launches
        WHERE chain_id = ${chainIdOf(chain)} AND token = ${token.toLowerCase()}
      `;
      if (launches.length > 0) {
        const l = launches[0];
        quoteDecimals = l.quote_decimals ?? 18;
        feesCollectedRaw = Number(l.fees_quote_collected ?? "0");
        feesBurnedRaw = Number(l.fees_quote_burned ?? "0");
      }
    }
    const panel = await memo(`metrics:${chain}:${token.toLowerCase()}`, 30_000, () => getHolderPanel(chain, token));
    if (!panel) return NextResponse.json({ error: "not found" }, { status: 404 });
    const swaps = await memo(`swaps:${chain}:${token.toLowerCase()}_metrics`, 30_000, () => getSwaps(chain, token, quoteDecimals, 50));
    const trades = swaps.length;
    // Volume in display units (divided by 10^quoteDecimals), matching the page's fmt() logic.
    const volumeUsd = swaps.reduce((acc, s) => acc + Math.abs(Number(s.amount1)) / 10 ** quoteDecimals, 0);
    const feesCollectedUsd = feesCollectedRaw / 10 ** quoteDecimals;
    const feesBurnedUsd = feesBurnedRaw / 10 ** quoteDecimals;
    const topHolders = panel.top.slice(0, 5).map((h) => ({ address: h.address, balance: h.balance, bps: h.bps }));
    return NextResponse.json({
      holders: panel.holders,
      supply: panel.supply ?? (quoteDecimals ? `${Number(panel.supply ?? "0") / 10 ** quoteDecimals}.0` : "0"),
      quote_decimals: quoteDecimals,
      topHolders,
      trades,
      volume_usd: volumeUsd,
      fees_collected_usd: feesCollectedUsd,
      fees_burned_usd: feesBurnedUsd,
      top10Bps: panel.top10Bps,
      poolBps: panel.poolBps,
    }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[launch] metrics failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load metrics" }, { status: 502 });
  }
}