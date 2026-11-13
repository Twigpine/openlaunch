import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  path: "/launch/details",
  title: "Launch details",
  description: "Per‑launch metrics: holders, trades, volume, fees and top holders.",
});

export const dynamic = "force-dynamic";

type LaunchMetrics = {
  holders: number;
  supply: string;
  quote_decimals: number;
  topHolders: Array<{ address: string; balance: string; bps: number }>;
  trades: number;
  volume_usd: number;
  fees_collected_usd: number;
  fees_burned_usd: number;
  top10Bps: number;
  poolBps: number;
  token: string;
  chain: string;
};

export default async function LaunchDetailsPage(
  // Search params from the URL: /launch/details?chain=<chain>&token=<token>
  searchParams: { chain?: string; token?: string }
) {
  const chain: string = searchParams.chain || "base";
  const token: string = searchParams.token || "0x".repeat(40);

  // Fetch metrics from the API
  const res = await fetch(`/api/launch/metrics?chain=${chain}&token=${token}`);
  if (!res.ok) {
    // Return empty state on failure
    return (
      <main className="relative mx-auto max-w-6xl px-4 pt-6 sm:pt-10 pb-16 space-y-5 sm:space-y-6">
        <p className="text-muted">Failed to load metrics.</p>
      </main>
    );
  }
  const data = (await res.json()) as LaunchMetrics;

  if (!data.token || !data.chain) {
    return (
      <main className="relative mx-auto max-w-6xl px-4 pt-6 sm:pt-10 pb-16 space-y-5 sm:space-y-6">
        <p>No data for this launch.</p>
      </main>
    );
  }

  const fmt = (n: number | string | null) => (n == null ? "—" : Number(n).toLocaleString());

  return (
    <main className="relative mx-auto max-w-6xl px-4 pt-6 sm:pt-10 pb-16 space-y-5 sm:space-y-6">
      <header className="max-w-2xl">
        <h1 className="font-display font-bold tracking-[-0.02em] text-ink text-3xl sm:text-4xl">
          {data.token} · {data.chain}
        </h1>
        <p className="mt-2 text-base text-body">
          Metrics for {data.token} on {data.chain}
        </p>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="rounded-md border border-border p-4">
          <dt className="text-muted">Holders</dt>
          <dd>{fmt(data.holders)}</dd>
        </div>
        <div className="rounded-md border border-border p-4">
          <dt className="text-muted">Supply</dt>
          <dd>{fmt(Number(data.supply) / 10 ** Number(data.quote_decimals))} {data.token.substring(0, 6)}…</dd>
        </div>
        <div className="rounded-md border border-border p-4">
          <dt className="text-muted">Trades (50 most recent)</dt>
          <dd>{fmt(data.trades)}</dd>
        </div>
        <div className="rounded-md border border-border p-4">
          <dt className="text-muted">Volume (native)</dt>
          <dd>${fmt(data.volume_usd)}</dd>
        </div>
        <div className="rounded-md border border-border p-4">
          <dt className="text-muted">Fees collected (native)</dt>
          <dd>${fmt(data.fees_collected_usd)}</dd>
        </div>
        <div className="rounded-md border border-border p-4">
          <dt className="text-muted">Fees burned (native)</dt>
          <dd>${fmt(data.fees_burned_usd)}</dd>
        </div>
      </section>

      <section className="mt-6">
        <dt className="text-muted">Top 5 holders</dt>
        <dl className="space-y-1">
          {data.topHolders.map((h, i) => (
            <div key={i} className="flex items-baseline justify-between text-sm">
              <span>{h.address.substring(0, 6)}…{h.address.substring(-4)}</span>
              <span>{fmt(h.bps)} bps</span>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}