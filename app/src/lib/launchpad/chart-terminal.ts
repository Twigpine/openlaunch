import { defaultInterval, INTERVAL_KEYS, INTERVALS, type Candle, type Interval } from "./candles.ts";

export type ChartRange = "auto" | "1d" | "7d" | "30d" | "all";

/**
 * Range shortcuts choose a useful resolution, then request the real history.
 * The API still owns payload limits. An All range older than 1,500 daily bars
 * falls back to daily resolution without pretending a truncated range is All.
 */
export function chartRangeSelection(range: ChartRange, launchT: number, now: number): { interval: Interval; from: number | undefined } {
  if (range === "auto") return { interval: defaultInterval(Math.max(0, now - launchT)), from: undefined };
  if (range === "all") {
    const interval = INTERVAL_KEYS.find((key) => Math.floor(now / INTERVALS[key]) - Math.floor(launchT / INTERVALS[key]) + 1 <= 1500) ?? "1d";
    return { interval, from: launchT };
  }
  const options = { "1d": { interval: "5m", seconds: 86400 }, "7d": { interval: "1h", seconds: 7 * 86400 }, "30d": { interval: "4h", seconds: 30 * 86400 } } as const;
  const selected = options[range];
  return { interval: selected.interval, from: Math.max(launchT, now - selected.seconds) };
}

const normalPrice = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 });
const axisPrice = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });
const compactPrice = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 4 });
const preciseAxisPrice = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 });
const compactAxisPrice = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 6 });

function scientificPrice(value: number, decimals: number): string {
  return value.toExponential(decimals).replace(/(\.\d*?[1-9])0+e/, "$1e").replace(/\.0+e/, "e");
}

/** Numeric label only. The caller must label the actual USD or quote currency. */
export function formatChartPrice(value: number, compact = false): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  // A fixed decimal precision can silently turn a genuine small token price
  // into zero. Scientific notation keeps axis/hover labels short and truthful.
  if (magnitude < 0.000001 || magnitude >= 1e15) {
    return scientificPrice(value, compact ? 3 : 7);
  }
  if (compact && magnitude >= 1000) return compactPrice.format(value);
  return (compact ? axisPrice : normalPrice).format(value);
}

/** Keep neighboring axis ticks distinct at the chart's six-significant-digit step. */
export function formatChartAxis(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude < 0.000001 || magnitude >= 1e15) return scientificPrice(value, 5);
  return (magnitude >= 1000 ? compactAxisPrice : preciseAxisPrice).format(value);
}

/** How long a stretch of the chart covers, as a short label: "45m", "18h", "4d". Empty for no stretch at all. */
export function chartSpanLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 2 * 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export type WalletChartMarker = { t: number; is_buy: boolean; quote: string };
export type WalletChartMarkerBucket = { t: number; is_buy: boolean; count: number };

/**
 * Group a complete wallet snapshot for display only. Equal timestamp/amount
 * trades can be separate real events, so never deduplicate that tuple.
 */
export function aggregateWalletMarkers(markers: readonly WalletChartMarker[], intervalS: number, fromTime = -Infinity, toTime = Infinity): WalletChartMarkerBucket[] {
  if (!Number.isFinite(intervalS) || intervalS <= 0) throw new RangeError("Marker interval must be positive and finite");
  const byBucket = new Map<string, WalletChartMarkerBucket>();
  for (const marker of markers) {
    if (marker.t < fromTime || marker.t > toTime) continue;
    const t = Math.floor(marker.t / intervalS) * intervalS;
    const key = `${t}:${marker.is_buy}`;
    const bucket = byBucket.get(key);
    if (bucket) bucket.count++;
    else byBucket.set(key, { t, is_buy: marker.is_buy, count: 1 });
  }
  return [...byBucket.values()].sort((a, b) => a.t - b.t || Number(b.is_buy) - Number(a.is_buy));
}

export type ChartRangeStats = {
  open: number;
  close: number;
  /** Fraction, not percent; null when the opening value cannot be a base. */
  change: number | null;
  high: number | null;
  low: number | null;
  /** Quote-asset volume, unchanged by price/market-cap display conversion. */
  volume: number;
  trades: number;
};

/** Summarize the actual visible bucket starts, including a carried opening price. */
export function selectedRangeStats(candles: readonly Candle[], fromTime = -Infinity, toTime = Infinity): ChartRangeStats | null {
  const visible = candles.filter((candle) => candle.t >= fromTime && candle.t <= toTime).sort((a, b) => a.t - b.t);
  if (visible.length === 0) return null;
  const open = visible[0].open;
  const close = visible[visible.length - 1].close;
  const traded = visible.filter((candle) => !candle.filled);
  return {
    open,
    close,
    change: open > 0 && Number.isFinite(open) && Number.isFinite(close) ? close / open - 1 : null,
    high: traded.length ? Math.max(...traded.map((candle) => candle.high)) : null,
    low: traded.length ? Math.min(...traded.map((candle) => candle.low)) : null,
    volume: visible.reduce((sum, candle) => sum + candle.volume, 0),
    trades: visible.reduce((sum, candle) => sum + candle.trades, 0),
  };
}

/** A history that spans this many times from its lowest low to its highest high opens on a log scale. */
export const LOG_SCALE_SPAN = 10;

/**
 * Log for a launch-day spike that would flatten today's price into the floor of a linear axis; linear otherwise.
 * Only traded buckets count: a carried price is not a low.
 */
export function defaultChartScale(candles: readonly Candle[]): "log" | "normal" {
  let low = Infinity;
  let high = 0;
  for (const candle of candles) {
    if (candle.filled) continue;
    if (candle.low > 0 && candle.low < low) low = candle.low;
    if (candle.high > high) high = candle.high;
  }
  return Number.isFinite(low) && high / low >= LOG_SCALE_SPAN ? "log" : "normal";
}

export type ChartLandmark = { t: number; kind: "launch" | "peak"; value: number };
/** A peak in the newest this-many buckets gets no label: it is the current price, and the label would meet the axis. */
const PEAK_CLEARANCE = 3;

/**
 * Where the line starts and where it peaked, for labels on the chart. The launch mark needs the launch inside the
 * first loaded bucket; the peak is the highest traded high, left out when it sits in the newest few buckets (the price
 * label already says where it is now, and a label there would run under the axis) or when there are too few buckets
 * for a peak to mean anything.
 */
export function chartLandmarks(candles: readonly Candle[], launchT: number, intervalS: number): ChartLandmark[] {
  if (candles.length < 3) return [];
  const out: ChartLandmark[] = [];
  const first = candles[0];
  if (launchT >= first.t && launchT < first.t + intervalS) out.push({ t: first.t, kind: "launch", value: first.open });
  let peak = -1;
  for (let i = 0; i < candles.length; i++) if (!candles[i].filled && (peak < 0 || candles[i].high > candles[peak].high)) peak = i;
  if (peak >= 0 && peak < candles.length - PEAK_CLEARANCE) out.push({ t: candles[peak].t, kind: "peak", value: candles[peak].high });
  return out;
}
