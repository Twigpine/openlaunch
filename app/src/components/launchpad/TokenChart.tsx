"use client";

import { useState } from "react";
import { useTheme } from "next-themes";
import { ArrowUpRight } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import { isChartPool, type ChartPool } from "@/lib/launchpad/chart-pool";
import { geckoChartUrl, type GeckoStatus } from "@/lib/launchpad/geckoterminal";
import PriceChart from "./PriceChart";

type Props = ChartPool & { symbol: string; launchedAt: string; hasTrades: boolean };
type Lookup = "idle" | "checking" | GeckoStatus | "error";
const notAvailable: Record<Exclude<Lookup, "idle" | "checking" | "ready">, string> = {
  unlisted: "GeckoTerminal has not indexed this pool yet.",
  inverted: "GeckoTerminal lists this pool the other way round, so its chart would show the pair token.",
  unpriced: "GeckoTerminal has no usable USD price for this pool yet.",
  error: "GeckoTerminal could not be checked just now.",
};

/**
 * The token chart. Our own chart from indexed Uniswap v4 swaps is the default; GeckoTerminal's hosted chart (with
 * its drawing tools) is one tap away for pools it has indexed. The pool is checked only when someone asks for it,
 * and only an exact match of pool, token and pair is ever shown as this token.
 */
export default function TokenChart(props: Props) {
  const { chain, token, symbol, launchedAt, hasTrades } = props;
  const { resolvedTheme } = useTheme();
  const [source, setSource] = useState<"onchain" | "gecko">("onchain");
  const [lookup, setLookup] = useState<Lookup>("idle");
  const valid = isChartPool(props);
  const pool: ChartPool = { chain, token, poolId: props.poolId, quote: props.quote };
  const theme = resolvedTheme === "dark" ? "dark" : "light";

  async function check() {
    setLookup("checking");
    try {
      const query = new URLSearchParams({ chain, token, pool: props.poolId, quote: props.quote });
      const response = await fetch(`/api/launch/chart-provider?${query}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const result: unknown = response.ok ? await response.json() : null;
      const status = result && typeof result === "object" && "status" in result ? String(result.status) : "";
      setLookup(["ready", "unlisted", "inverted", "unpriced"].includes(status) ? status as GeckoStatus : "error");
    } catch {
      setLookup("error");
    }
  }

  function pick(next: "onchain" | "gecko") {
    setSource(next);
    if (next === "gecko" && lookup !== "ready" && lookup !== "checking") void check();
  }

  const showGecko = source === "gecko" && lookup === "ready";
  return (
    <div className="min-w-0 space-y-2">
      {valid && hasTrades ? (
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {source === "gecko" && lookup !== "ready" && lookup !== "idle" ? (
            <p role="status" className="mr-auto text-xs text-muted">{lookup === "checking" ? "Finding this pool on GeckoTerminal…" : `${notAvailable[lookup]} Showing our own chart.`}</p>
          ) : null}
          <ToggleGroup aria-label="Chart source" value={[source]} onValueChange={(values) => { const next = values[0]; if (next === "onchain" || next === "gecko") pick(next); }}>
            <ToggleGroupItem value="onchain" className="px-2.5 text-[11px]">On-chain</ToggleGroupItem>
            <ToggleGroupItem value="gecko" className="px-2.5 text-[11px]">GeckoTerminal</ToggleGroupItem>
          </ToggleGroup>
        </div>
      ) : null}
      {showGecko ? (
        <section aria-label={`${symbol} chart by GeckoTerminal`} className="overflow-hidden rounded-2xl border border-line bg-paper">
          <iframe
            key={theme}
            title={`${symbol} chart by GeckoTerminal`}
            src={geckoChartUrl(pool, theme, { interval: "15m", metric: "price" })}
            className="block h-[min(72svh,640px)] min-h-[440px] w-full border-0 bg-paper"
            allow="clipboard-write"
            allowFullScreen
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
          />
          <p className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[11px] text-muted">
            <span>Chart and market data by GeckoTerminal. Blank chart? Switch back to On-chain.</span>
            <a href={geckoChartUrl(pool, theme)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-body hover:text-ink">Open on GeckoTerminal<ArrowUpRight size={12} aria-hidden="true" /></a>
          </p>
        </section>
      ) : (
        <PriceChart key={`${chain}:${token}`} chain={chain} token={token} symbol={symbol} launchedAt={launchedAt} />
      )}
    </div>
  );
}
