"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import NumberFlow, { type Format } from "@number-flow/react";
import {
  BaselineSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LastPriceAnimationMode, LineStyle, LineType, PriceScaleMode,
  createChart, createSeriesMarkers, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { Popover } from "@base-ui/react/popover";
import { ChartArea, ChartCandlestick, ChartNoAxesColumn, Expand, Info, Shrink, Wallet } from "lucide-react";
import type { ChainKey } from "@/lib/chainPublic";
import { INTERVAL_KEYS, INTERVALS, fillCandles, type Interval } from "@/lib/launchpad/candles";
import { chartAlpha } from "@/lib/launchpad/chart-display";
import { aggregateWalletMarkers, chartSpanLabel, defaultChartScale, formatChartAxis, formatChartPrice, selectedRangeStats, type ChartRange } from "@/lib/launchpad/chart-terminal";
import type { ChartPayload } from "@/lib/launchpad/chart-payload";
import { prepareChartSeries } from "@/lib/launchpad/chart-render";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import { Sk } from "@/components/Skeleton";
import ChangeChip from "./ChangeChip";
import styles from "./TradingChart.module.css";

type Props = {
  chain: ChainKey; token: string; symbol: string; data: ChartPayload | null;
  interval: Interval; range: ChartRange; loading: boolean; error: string | null; hasWallet: boolean;
  onIntervalChange: (interval: Interval) => void; onRefresh: () => void;
};
type View = "line" | "candles";
const utcTime = (time: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(time * 1000);

/** The line's area: green above the reference price, red below it, each fading toward the reference line. */
const fills = (up: string, down: string) => ({
  topLineColor: up, topFillColor1: chartAlpha(up, 0.26), topFillColor2: chartAlpha(up, 0.02),
  bottomLineColor: down, bottomFillColor1: chartAlpha(down, 0.02), bottomFillColor2: chartAlpha(down, 0.26),
});

/** The big figure. Its digits roll on a live update and jump straight to the value while scrubbing; NumberFlow has no
 *  scientific notation, so a tiny or huge value keeps the chart's own text format. */
function Readout({ value, usd, animated }: { value: number | undefined; usd: boolean; animated: boolean }) {
  if (value === undefined || !Number.isFinite(value)) return <span>—</span>;
  const magnitude = Math.abs(value);
  if (magnitude < 0.000001 || magnitude >= 1e15) return <span>{usd ? "$" : ""}{formatChartPrice(value, true)}</span>;
  const format: Format = magnitude >= 1000 ? { notation: "compact", maximumSignificantDigits: 4 } : { maximumSignificantDigits: 6 };
  return <NumberFlow value={value} format={usd ? { ...format, style: "currency", currency: "USD" } : format} locales="en-US" animated={animated} willChange={false} />;
}

/** The real renderer, also usable in isolated read-only data reviews. */
export default function TradingChart({ chain, token, symbol, data, interval, range, loading, error, hasWallet, onIntervalChange, onRefresh }: Props) {
  const [metric, setMetric] = useState<"mcap" | "price">("mcap");
  const [denomination, setDenomination] = useState<"usd" | "quote">("usd");
  const [view, setView] = useState<View>("line");
  const [volume, setVolume] = useState(true);
  const [showTrades, setShowTrades] = useState(true);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [visible, setVisible] = useState<{ from: number; to: number } | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const panel = useRef<HTMLElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const line = useRef<ISeriesApi<"Baseline"> | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const histogram = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const reference = useRef<{ series: ISeriesApi<"Baseline"> | ISeriesApi<"Candlestick">; line: IPriceLine } | null>(null);
  const fitted = useRef("");
  const scaledUnit = useRef("");
  const keyboardInspection = useRef(false);
  const helpId = useId();
  const fullscreenAvailable = useSyncExternalStore(() => () => {}, () => Boolean(document.fullscreenEnabled), () => false);
  const usdAvailable = data?.quote.usd != null && Number.isFinite(data.quote.usd) && data.quote.usd > 0;
  const usd = denomination === "usd" && usdAvailable;
  const currency = usd ? "USD" : data?.quote.symbol ?? "Quote";
  const prepared = useMemo(() => {
    // no trade yet: an empty chart, never a flat line drawn from the launch price
    if (!data || (!data.baseline.hasPriorTrades && !data.candles.length)) return prepareChartSeries([], [1]);
    const dense = fillCandles(data.candles, INTERVALS[interval], data.from, data.asOf, data.baseline.price);
    return prepareChartSeries(dense, [metric === "mcap" ? data.supply : 1, usd ? data.quote.usd! : 1]);
  }, [data, interval, metric, usd]);
  const series = prepared.display;
  // the scale follows the history: log when a launch spike would flatten today's price into the floor of a linear axis
  const scale = defaultChartScale(series);
  const unit = `${metric}:${currency}:${prepared.priceDivisor}`;
  const byTime = useMemo(() => new Map(series.map((bar) => [bar.t, bar])), [series]);
  const inspected = hoverTime === null ? null : byTime.get(hoverTime) ?? null;
  const latest = series.at(-1);
  const shown = inspected ?? latest;
  const stats = useMemo(() => selectedRangeStats(series, visible?.from, visible?.to), [series, visible]);
  // scrubbing reads against the first candle in view, like the resting figure does
  const change = inspected ? (stats && stats.open > 0 ? inspected.close / stats.open - 1 : null) : stats?.change ?? null;
  const span = visible ? chartSpanLabel(visible.to - visible.from + INTERVALS[interval]) : "";
  // the price the fill flips at: the launch price when the loaded history starts at launch, else its first open
  const anchor = useMemo(() => {
    const first = series[0];
    if (!data || !first) return null;
    const launchInView = data.launch.t >= first.t && data.launch.t < first.t + INTERVALS[interval];
    const launch = data.launch.price * (metric === "mcap" ? data.supply : 1) * (usd ? data.quote.usd! : 1);
    return launchInView && Number.isFinite(launch) && launch > 0 ? { value: launch, label: "Launch" } : { value: first.open, label: "Open" };
  }, [data, series, interval, metric, usd]);
  const noWindowTrades = data?.candles.length === 0;
  const hasHistory = Boolean(data?.baseline.hasPriorTrades || data?.candles.length);
  const fmt = (value: number, compact = false) => `${usd ? "$" : ""}${formatChartPrice(value, compact)}`;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const tokenColor = (name: string) => getComputedStyle(el).getPropertyValue(`--color-${name}`).trim();
    const crosshairLine =() => ({ color: chartAlpha(tokenColor("muted"), 0.55), width: 1 as const, style: LineStyle.Dashed, labelBackgroundColor: tokenColor("ink") });
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: tokenColor("card") }, textColor: tokenColor("muted"), fontFamily: getComputedStyle(el).fontFamily, fontSize: 11, attributionLogo: true },
      grid: { vertLines: { visible: false }, horzLines: { color: tokenColor("chart-grid"), style: LineStyle.Dotted } },
      // the bottom margin leaves the volume bars their own strip under the line
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.2 }, minimumWidth: 64, entireTextOnly: true },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 6, shiftVisibleRangeOnNewBar: false, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true },
      crosshair: { mode: CrosshairMode.Magnet, vertLine: crosshairLine(), horzLine: { ...crosshairLine(), visible: false } },
      // A global priceFormatter overrides the per-series formatters, including
      // the volume strip. Each series must restore its own normalized units.
      localization: { locale: "en-US", timeFormatter: (time: Time) => typeof time === "number" ? `${utcTime(time)} UTC` : String(time) },
    });
    line.current = c.addSeries(BaselineSeries, { lineWidth: 2, lineType: LineType.Simple, priceLineStyle: LineStyle.Dashed,
      crosshairMarkerRadius: 5, crosshairMarkerBorderWidth: 2, crosshairMarkerBorderColor: tokenColor("card"),
      ...fills(tokenColor("up"), tokenColor("down")) });
    candles.current = c.addSeries(CandlestickSeries, { visible: false, borderVisible: false, priceLineStyle: LineStyle.Dashed, upColor: tokenColor("up"), downColor: tokenColor("down"), wickUpColor: tokenColor("up"), wickDownColor: tokenColor("down") });
    // volume shares the pane on its own overlay scale, pinned to the bottom strip
    histogram.current = c.addSeries(HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    histogram.current.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    chart.current = c;
    const onCrosshair: Parameters<IChartApi["subscribeCrosshairMove"]>[0] = (event) => {
      if (!keyboardInspection.current) setHoverTime(typeof event.time === "number" ? event.time : null);
    };
    const onRange: Parameters<ReturnType<IChartApi["timeScale"]>["subscribeVisibleTimeRangeChange"]>[0] = (next) => {
      const nextRange = next && typeof next.from === "number" && typeof next.to === "number" ? { from: next.from, to: next.to } : null;
      setVisible((current) => current?.from === nextRange?.from && current?.to === nextRange?.to ? current : nextRange);
    };
    c.subscribeCrosshairMove(onCrosshair);
    c.timeScale().subscribeVisibleTimeRangeChange(onRange);
    const syncTheme = () => {
      c.applyOptions({ layout: { background: { type: ColorType.Solid, color: tokenColor("card") }, textColor: tokenColor("muted") },
        grid: { horzLines: { color: tokenColor("chart-grid") } }, crosshair: { vertLine: crosshairLine(), horzLine: crosshairLine() } });
      line.current?.applyOptions({ crosshairMarkerBorderColor: tokenColor("card"), ...fills(tokenColor("up"), tokenColor("down")) });
      candles.current?.applyOptions({ upColor: tokenColor("up"), downColor: tokenColor("down"), wickUpColor: tokenColor("up"), wickDownColor: tokenColor("down") });
      setThemeTick((tick) => tick + 1);
    };
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => { observer.disconnect(); c.unsubscribeCrosshairMove(onCrosshair); c.timeScale().unsubscribeVisibleTimeRangeChange(onRange); markers.current?.detach(); markers.current = null; reference.current = null; c.remove(); chart.current = null; line.current = null; candles.current = null; histogram.current = null; fitted.current = ""; };
  }, []);

  useEffect(() => {
    const c = chart.current;
    const ls = line.current;
    const cs = candles.current;
    const hs = histogram.current;
    const el = box.current;
    if (!c || !ls || !cs || !hs || !el) return;
    const tokenColor = (name: string) => getComputedStyle(el).getPropertyValue(`--color-${name}`).trim();
    const logicalRange = c.timeScale().getVisibleLogicalRange();
    const previousFirst = ls.data()[0]?.time;
    const value = prepared.render.at(-1)?.close ?? 1;
    const minMove = Math.max(1e-16, 10 ** (Math.floor(Math.log10(Math.max(value, 1e-16))) - 5));
    const priceFormat = { type: "custom" as const, minMove, formatter: (coordinate: number) => formatChartAxis(coordinate * prepared.priceDivisor) };
    const referencePrice = anchor ? anchor.value / prepared.priceDivisor : value;
    // the live pulse is drawn even for a hidden series, so it goes off with the line
    const pulse = view === "line" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ls.applyOptions({ visible: view === "line", priceFormat, baseValue: { type: "price", price: referencePrice }, lastPriceAnimation: pulse ? LastPriceAnimationMode.Continuous : LastPriceAnimationMode.Disabled });
    cs.applyOptions({ visible: view === "candles", priceFormat });
    // the line snaps the crosshair to its value; candles keep a free crosshair with its price line
    c.applyOptions({ crosshair: { mode: view === "line" ? CrosshairMode.Magnet : CrosshairMode.Normal, horzLine: { visible: view === "candles" } } });
    // a new unit (metric, currency or canvas normalization) starts from an automatic price range again
    ls.priceScale().applyOptions({ mode: scale === "log" ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal, ...(scaledUnit.current !== unit ? { autoScale: true } : {}) });
    scaledUnit.current = unit;
    const up = tokenColor("up");
    const down = tokenColor("down");
    const neutral = tokenColor("muted");
    ls.setData(prepared.render.map((bar) => ({ time: bar.t as UTCTimestamp, value: bar.close })));
    cs.setData(prepared.render.map((bar) => ({ time: bar.t as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close, ...(bar.filled ? { color: neutral, borderColor: neutral, wickColor: neutral } : {}) })));
    hs.applyOptions({ visible: volume, priceFormat: { type: "custom", minMove: 1e-6, formatter: (coordinate: number) => formatChartAxis(coordinate * prepared.volumeDivisor) } });
    hs.setData(prepared.render.map((bar) => ({ time: bar.t as UTCTimestamp, value: bar.volume, color: chartAlpha(bar.close >= bar.open ? up : down, view === "line" ? 0.35 : 0.55) })));
    // the reference price as a quiet dashed line, labelled on the axis, on whichever series is showing
    const active = view === "candles" ? cs : ls;
    if (reference.current) reference.current.series.removePriceLine(reference.current.line);
    reference.current = anchor && prepared.render.length ? { series: active, line: active.createPriceLine({ price: referencePrice, color: chartAlpha(neutral, 0.7), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: anchor.label, axisLabelColor: tokenColor("line-strong"), axisLabelTextColor: tokenColor("ink") }) } : null;
    markers.current?.detach();
    const own = hasWallet && showTrades ? aggregateWalletMarkers(data?.mine ?? [], INTERVALS[interval], series[0]?.t, series.at(-1)?.t === undefined ? undefined : series.at(-1)!.t + INTERVALS[interval] - 1) : [];
    markers.current = createSeriesMarkers(active, own.map((trade) => ({ time: trade.t as UTCTimestamp, position: trade.is_buy ? "belowBar" as const : "aboveBar" as const,
      color: trade.is_buy ? up : down, shape: trade.is_buy ? "arrowUp" as const : "arrowDown" as const,
      text: `${trade.count > 1 ? `${trade.count} ` : ""}${trade.is_buy ? "buy" : "sell"}${trade.count > 1 ? "s" : ""}` })));
    const fitKey = `${chain}:${token}:${interval}:${range}`;
    if (series.length && fitted.current !== fitKey) {
      c.timeScale().fitContent();
      fitted.current = fitKey;
      // each new history draws in from the left, once
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) el.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 700, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    }
    else if (logicalRange && series.length) {
      // A rolling window drops leading bars. Keep the same timestamps under
      // the crosshair, including fractional zoom and whitespace at the edges.
      const shift = typeof previousFirst === "number" ? (series[0].t - previousFirst) / INTERVALS[interval] : 0;
      c.timeScale().setVisibleLogicalRange({ from: logicalRange.from - shift, to: logicalRange.to - shift });
    }
    if (!series.length) fitted.current = "";
  }, [prepared, series, data, anchor, interval, range, unit, themeTick, view, volume, scale, showTrades, hasWallet, chain, token]);

  useEffect(() => {
    let wasActive = false;
    const onChange = () => { const active = document.fullscreenElement === panel.current; setFullscreen(active); if (wasActive && !active) fullscreenButton.current?.focus(); wasActive = active; };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  async function toggleFullscreen() {
    try { if (document.fullscreenElement === panel.current) await document.exitFullscreen(); else await panel.current?.requestFullscreen(); }
    catch { setAnnouncement("Your browser couldn’t open fullscreen. You can still zoom and pan the chart."); }
  }
  function inspectBar(direction: string) {
    if (!series.length) return;
    const current = hoverTime === null ? series.length - 1 : series.findIndex((bar) => bar.t === hoverTime);
    const index = direction === "Home" ? 0 : direction === "End" ? series.length - 1 : Math.max(0, Math.min(series.length - 1, current + (direction === "ArrowLeft" ? -1 : 1)));
    const bar = series[index];
    keyboardInspection.current = true;
    setHoverTime(bar.t);
    const viewport = chart.current?.timeScale().getVisibleLogicalRange();
    const logical = index; // every loaded bucket is a bar on the time scale, in order
    if (viewport && (logical < viewport.from || logical > viewport.to)) {
      const width = viewport.to - viewport.from;
      chart.current?.timeScale().setVisibleLogicalRange(logical < viewport.from ? { from: logical, to: logical + width } : { from: logical - width, to: logical });
    }
    chart.current?.setCrosshairPosition(bar.close / prepared.priceDivisor, bar.t as UTCTimestamp, (view === "candles" ? candles.current : line.current)!);
    setAnnouncement(`${utcTime(bar.t)} UTC. Open ${fmt(bar.open)}, high ${fmt(bar.high)}, low ${fmt(bar.low)}, close ${fmt(bar.close)} ${currency}. Volume ${formatChartPrice(bar.volume)} ${data?.quote.symbol}. ${bar.filled ? "No swaps in this bucket; carried price." : `${bar.trades} trades.`}`);
  }
  function fitAll() { line.current?.priceScale().applyOptions({ autoScale: true }); chart.current?.timeScale().fitContent(); }

  return (
    <section ref={panel} className={styles.terminal} aria-label={`${symbol} market chart`}>
      <header className={styles.header}>
        <div className={styles.top}>
          <ToggleGroup aria-label="Chart metric" value={[metric]} onValueChange={(values) => { if (values[0]) setMetric(values[0] as "mcap" | "price"); }} className={styles.compact}>
            <ToggleGroupItem value="mcap" className={styles.compactItem}>Market cap</ToggleGroupItem>
            <ToggleGroupItem value="price" className={styles.compactItem}>Price</ToggleGroupItem>
          </ToggleGroup>
          <div className={styles.controls}>
            <ToggleGroup aria-label="Chart type" value={[view]} onValueChange={(values) => { if (values[0]) setView(values[0] as View); }} className={styles.compact}>
              <ToggleGroupItem value="line" aria-label="Line chart" title="Line" className={styles.iconItem}><ChartArea size={15} aria-hidden /></ToggleGroupItem>
              <ToggleGroupItem value="candles" aria-label="Candlestick chart" title="Candles" className={styles.iconItem}><ChartCandlestick size={15} aria-hidden /></ToggleGroupItem>
            </ToggleGroup>
            <button type="button" ref={fullscreenButton} className={styles.iconButton} onClick={() => void toggleFullscreen()} disabled={!fullscreenAvailable} aria-label={fullscreen ? "Exit chart fullscreen" : "Enter chart fullscreen"} title={fullscreenAvailable ? "Fullscreen chart" : "Fullscreen isn’t available in this browser"}>{fullscreen ? <Shrink size={15} aria-hidden /> : <Expand size={15} aria-hidden />}</button>
          </div>
        </div>
        <div className={styles.value}>
          <span className={styles.figure} title={shown ? `${shown.close} ${currency}` : undefined}><Readout value={shown?.close} usd={usd} animated={!inspected} /></span>
          {/* the figure's unit is its own switch: dollars, or the pool's quote token */}
          {usdAvailable ? (
            <ToggleGroup aria-label="Chart currency" value={[usd ? "usd" : "quote"]} onValueChange={(values) => { if (values[0]) setDenomination(values[0] as "usd" | "quote"); }} className={styles.unitGroup}>
              <ToggleGroupItem value="usd" className={styles.unitItem}>USD</ToggleGroupItem>
              <ToggleGroupItem value="quote" className={styles.unitItem}>{data?.quote.symbol ?? "Quote"}</ToggleGroupItem>
            </ToggleGroup>
          ) : <span className={styles.unit}>{currency}</span>}
          {usd ? (
            <Popover.Root>
              <Popover.Trigger openOnHover delay={120} aria-label="How USD values are worked out" className={styles.info}><Info size={13} aria-hidden /></Popover.Trigger>
              {/* inside the card, so the note still opens while the chart is fullscreen */}
              <Popover.Portal container={panel}>
                <Popover.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={12} className="z-50">
                  <Popover.Popup className="w-60 origin-(--transform-origin) rounded-xl border border-line bg-raised p-3 text-xs leading-relaxed text-body shadow-dialog outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 motion-reduce:transition-none">
                    Every candle is converted to USD at today’s {data?.quote.symbol} price, not the rate at the time.
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          ) : null}
        </div>
          <p className={styles.context}>
            {change !== null ? <ChangeChip v={change} context={inspected ? "against the first candle in view" : "across the visible candles"} /> : null}
            {inspected ? <time dateTime={new Date(inspected.t * 1000).toISOString()}>{utcTime(inspected.t)} UTC</time>
              : <span>{stats && span ? `${span} in view` : data && !hasHistory ? "Awaiting first swap" : "Waiting for chart data"}</span>}
            {error && data && !inspected ? <span role="status" className={styles.stale}>Refresh failed. Showing the last snapshot.</span> : null}
          </p>
          <p className={styles.details} aria-live="off">
            {inspected ? <>
              {view === "candles" ? ([["O", "open"], ["H", "high"], ["L", "low"], ["C", "close"]] as const).map(([label, key]) => <span key={key} title={`${key}: ${inspected[key]} ${currency}`}><b>{label}</b>{formatChartPrice(inspected[key], true)}</span>) : null}
              <span><b>Vol</b>{formatChartPrice(inspected.volume, true)} <small>{data?.quote.symbol ?? "Quote"}</small></span>
              {inspected.filled ? <span className={styles.carried}>Carried price · no swaps</span> : <span><b>Trades</b>{inspected.trades.toLocaleString("en-US")}</span>}
            </> : stats ? <>
              {stats.high !== null ? <span><b>High</b>{fmt(stats.high, true)}</span> : null}
              {stats.low !== null ? <span><b>Low</b>{fmt(stats.low, true)}</span> : null}
              <span><b>Vol</b>{formatChartPrice(stats.volume, true)} <small>{data?.quote.symbol ?? "Quote"}</small></span>
              <span><b>Trades</b>{stats.trades.toLocaleString("en-US")}</span>
            </> : null}
          </p>
      </header>
      <div className={styles.plotWrap}>
        <div ref={box} className={styles.plot} tabIndex={0} role="group" aria-label={`${symbol} interactive ${metric === "mcap" ? "market cap" : "price"} chart, ${currency}`} aria-describedby={helpId}
          onPointerMove={() => { keyboardInspection.current = false; }}
          onDoubleClick={fitAll}
          onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); inspectBar(event.key); } else if (event.key === "Escape" && !fullscreen) { keyboardInspection.current = false; chart.current?.clearCrosshairPosition(); setHoverTime(null); setAnnouncement("Showing the latest candle."); } }} />
        {loading && !data ? <div className={styles.overlay} aria-label="Loading chart"><Sk className="h-full w-full rounded-xl" /></div> : null}
        {error && !data ? <div className={`${styles.overlay} ${styles.empty}`} role="status"><strong>Chart data is unavailable</strong><p>Try loading the indexed history again.</p><button type="button" onClick={onRefresh}>Retry chart</button></div> : null}
        {prepared.unavailable ? <div className={`${styles.overlay} ${styles.empty}`} role="status"><strong>This history can’t be charted safely</strong><p>The returned values are invalid or exceed supported numeric precision.</p><button type="button" onClick={onRefresh}>Retry chart</button></div> : null}
        {!loading && !error && !prepared.unavailable && noWindowTrades ? <div className={styles.note}><span>{hasHistory ? "A quiet window" : "No trades yet"}</span><small>{hasHistory ? "Showing the last indexed price. No swaps in this range." : "Candles appear after the first indexed swap. A launch price is not trading history."}</small></div> : null}
      </div>
      <div className={styles.bar}>
        <ToggleGroup aria-label="Chart interval" value={[interval]} onValueChange={(values) => { if (values[0]) onIntervalChange(values[0] as Interval); }} className={styles.intervals}>
          {INTERVAL_KEYS.map((key) => <ToggleGroupItem key={key} value={key} className={styles.interval}>{key === "1d" ? "1D" : key}</ToggleGroupItem>)}
        </ToggleGroup>
        <div className={styles.chips}>
          <button type="button" className={styles.chip} aria-pressed={volume} onClick={() => setVolume(!volume)}><ChartNoAxesColumn size={13} aria-hidden />Volume</button>
          {/* only a connected wallet has trades to mark; the markers read indexed history and never ask for a signature */}
          {hasWallet ? <button type="button" className={styles.chip} aria-pressed={showTrades} title="Show your latest 200 indexed trades within this range" onClick={() => setShowTrades(!showTrades)}><Wallet size={13} aria-hidden />My trades</button> : null}
        </div>
      </div>
      <p id={helpId} className="sr-only">Use left and right arrows to inspect candles, Home and End for the first and last loaded candle. Escape clears inspection, and a double click fits the whole history. Volume uses the pool quote currency. Filled gaps are carried prices, not executed trades.</p>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </section>
  );
}
