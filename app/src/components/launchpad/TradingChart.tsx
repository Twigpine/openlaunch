"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CandlestickSeries, CrosshairMode, HistogramSeries, LineSeries, PriceScaleMode, createChart, createSeriesMarkers, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp } from "lightweight-charts";
import { CandlestickChart, ChartNoAxesColumn, ChevronDown, LineChart, LocateFixed, Maximize2, Minimize2, RefreshCw, ScanLine } from "lucide-react";
import { CHAIN_SHORT, type ChainKey } from "@/lib/chainPublic";
import { INTERVAL_KEYS, INTERVALS, fillCandles, type Interval } from "@/lib/launchpad/candles";
import { chartAlpha } from "@/lib/launchpad/chart-display";
import { aggregateWalletMarkers, formatChartAxis, formatChartPrice, selectedRangeStats, type ChartRange } from "@/lib/launchpad/chart-terminal";
import type { ChartPayload } from "@/lib/launchpad/chart-payload";
import { prepareChartSeries } from "@/lib/launchpad/chart-render";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import { Sk } from "@/components/Skeleton";
import ChangeChip from "./ChangeChip";
import styles from "./TradingChart.module.css";

type Props = {
  chain: ChainKey; token: string; symbol: string; data: ChartPayload | null;
  interval: Interval; range: ChartRange; loading: boolean; error: string | null; hasWallet: boolean;
  onIntervalChange: (interval: Interval) => void; onRangeChange: (range: ChartRange) => void; onRefresh: () => void;
};
type View = "candles" | "line";
type Scale = "normal" | "log" | "percent";
const RANGES: [ChartRange, string][] = [["auto", "Auto"], ["1d", "1D"], ["7d", "1W"], ["30d", "1M"], ["all", "All"]];
const modeOf = (scale: Scale) => scale === "log" ? PriceScaleMode.Logarithmic : scale === "percent" ? PriceScaleMode.Percentage : PriceScaleMode.Normal;
const utcTime = (time: number, date = false) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...(date ? { day: "2-digit", month: "short" } as const : {}), hour: "2-digit", minute: "2-digit", ...(date ? {} : { second: "2-digit" } as const), hour12: false }).format(time * 1000);

/** The real renderer, also usable in isolated read-only data reviews. */
export default function TradingChart({ chain, token, symbol, data, interval, range, loading, error, hasWallet, onIntervalChange, onRangeChange, onRefresh }: Props) {
  const [metric, setMetric] = useState<"mcap" | "price">("mcap");
  const [denomination, setDenomination] = useState<"usd" | "quote">("usd");
  const [view, setView] = useState<View>("candles");
  const [scale, setScale] = useState<Scale>("normal");
  const [scalePreference, setScalePreference] = useState({ unit: "", automatic: true });
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
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const line = useRef<ISeriesApi<"Line"> | null>(null);
  const histogram = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const fitted = useRef("");
  const keyboardInspection = useRef(false);
  const helpId = useId();
  const fullscreenAvailable = useSyncExternalStore(() => () => {}, () => Boolean(document.fullscreenEnabled), () => false);
  const usdAvailable = data?.quote.usd != null && Number.isFinite(data.quote.usd) && data.quote.usd > 0;
  const usd = denomination === "usd" && usdAvailable;
  const currency = usd ? "USD" : data?.quote.symbol ?? "Quote";
  const prepared = useMemo(() => {
    if (!data || (!data.baseline.hasPriorTrades && !data.candles.length)) return prepareChartSeries([], [1]);
    const dense = fillCandles(data.candles, INTERVALS[interval], data.from, data.asOf, data.baseline.price);
    return prepareChartSeries(dense, [metric === "mcap" ? data.supply : 1, usd ? data.quote.usd! : 1]);
  }, [data, interval, metric, usd]);
  const series = prepared.display;
  const unit = `${metric}:${currency}:${prepared.priceDivisor}`;
  // Manual ranges also become incompatible if canvas normalization changes.
  const autoScale = scalePreference.unit !== unit || scalePreference.automatic;
  const byTime = useMemo(() => new Map(series.map((bar) => [bar.t, bar])), [series]);
  const inspected = (hoverTime === null ? null : byTime.get(hoverTime)) ?? series.at(-1);
  const latest = series.at(-1);
  const stats = useMemo(() => selectedRangeStats(series, visible?.from, visible?.to), [series, visible]);
  const noWindowTrades = data?.candles.length === 0;
  const hasHistory = Boolean(data?.baseline.hasPriorTrades || data?.candles.length);
  const fmt = (value: number, compact = false) => `${usd ? "$" : ""}${formatChartPrice(value, compact)}`;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const tokenColor = (name: string) => getComputedStyle(el).getPropertyValue(`--color-${name}`).trim();
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { color: tokenColor("paper") }, textColor: tokenColor("muted"), fontFamily: getComputedStyle(el).fontFamily, fontSize: 11, attributionLogo: true,
        panes: { separatorColor: tokenColor("line"), separatorHoverColor: tokenColor("line-strong"), enableResize: true } },
      grid: { vertLines: { color: tokenColor("chart-grid") }, horzLines: { color: tokenColor("chart-grid") } },
      rightPriceScale: { borderColor: tokenColor("line"), scaleMargins: { top: .12, bottom: .08 }, minimumWidth: 64 },
      timeScale: { borderColor: tokenColor("line"), timeVisible: true, secondsVisible: false, rightOffset: 5, shiftVisibleRangeOnNewBar: false },
      crosshair: { mode: CrosshairMode.Normal, horzLine: { color: tokenColor("muted"), labelBackgroundColor: tokenColor("ink") }, vertLine: { color: tokenColor("muted"), labelBackgroundColor: tokenColor("ink") } },
      // A global priceFormatter overrides the per-series formatters, including
      // the volume pane. Each series must restore its own normalized units.
      localization: { locale: "en-US", timeFormatter: (time: Time) => typeof time === "number" ? `${utcTime(time, true)} UTC` : String(time) },
    });
    candles.current = c.addSeries(CandlestickSeries, { upColor: tokenColor("up"), downColor: tokenColor("down"), borderVisible: false, wickUpColor: tokenColor("up"), wickDownColor: tokenColor("down") });
    line.current = c.addSeries(LineSeries, { color: tokenColor("brand"), lineWidth: 2, visible: false, crosshairMarkerRadius: 4 });
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
      c.applyOptions({ layout: { background: { color: tokenColor("paper") }, textColor: tokenColor("muted"), panes: { separatorColor: tokenColor("line"), separatorHoverColor: tokenColor("line-strong") } },
        grid: { vertLines: { color: tokenColor("chart-grid") }, horzLines: { color: tokenColor("chart-grid") } },
        rightPriceScale: { borderColor: tokenColor("line") }, timeScale: { borderColor: tokenColor("line") },
        crosshair: { horzLine: { color: tokenColor("muted"), labelBackgroundColor: tokenColor("ink") }, vertLine: { color: tokenColor("muted"), labelBackgroundColor: tokenColor("ink") } } });
      candles.current?.applyOptions({ upColor: tokenColor("up"), downColor: tokenColor("down"), wickUpColor: tokenColor("up"), wickDownColor: tokenColor("down") });
      line.current?.applyOptions({ color: tokenColor("brand") });
      setThemeTick((tick) => tick + 1);
    };
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => { observer.disconnect(); c.unsubscribeCrosshairMove(onCrosshair); c.timeScale().unsubscribeVisibleTimeRangeChange(onRange); markers.current?.detach(); markers.current = null; c.remove(); chart.current = null; candles.current = null; line.current = null; histogram.current = null; fitted.current = ""; };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (volume && !histogram.current) {
      histogram.current = c.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false }, 1);
      histogram.current.priceScale().applyOptions({ scaleMargins: { top: .15, bottom: 0 } });
      c.panes()[0]?.setStretchFactor(4);
      c.panes()[1]?.setStretchFactor(1);
    } else if (!volume && histogram.current) { c.removeSeries(histogram.current); histogram.current = null; }
  }, [volume]);

  useEffect(() => {
    const c = chart.current;
    const cs = candles.current;
    const ls = line.current;
    if (!c || !cs || !ls) return;
    const logicalRange = c.timeScale().getVisibleLogicalRange();
    const previousFirst = cs.data()[0]?.time;
    const value = prepared.render.at(-1)?.close ?? 1;
    const minMove = Math.max(1e-16, 10 ** (Math.floor(Math.log10(Math.max(value, 1e-16))) - 5));
    const priceFormat = { type: "custom" as const, minMove, formatter: (coordinate: number) => formatChartAxis(coordinate * prepared.priceDivisor) };
    cs.applyOptions({ visible: view === "candles", priceFormat });
    ls.applyOptions({ visible: view === "line", priceFormat });
    cs.priceScale().applyOptions({ mode: modeOf(scale), autoScale });
    const neutral = getComputedStyle(box.current!).getPropertyValue("--color-muted").trim();
    cs.setData(prepared.render.map((bar) => ({ time: bar.t as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close, ...(bar.filled ? { color: neutral, borderColor: neutral, wickColor: neutral } : {}) })));
    ls.setData(prepared.render.map((bar) => ({ time: bar.t as UTCTimestamp, value: bar.close })));
    const colors = cs.options();
    histogram.current?.applyOptions({ priceFormat: { type: "custom", minMove: 1e-6, formatter: (coordinate: number) => formatChartAxis(coordinate * prepared.volumeDivisor) } });
    histogram.current?.setData(prepared.render.map((bar) => ({ time: bar.t as UTCTimestamp, value: bar.volume, color: chartAlpha(bar.close >= bar.open ? colors.upColor : colors.downColor, .65) })));
    markers.current?.detach();
    const own = hasWallet && showTrades ? aggregateWalletMarkers(data?.mine ?? [], INTERVALS[interval], series[0]?.t, series.at(-1)?.t === undefined ? undefined : series.at(-1)!.t + INTERVALS[interval] - 1) : [];
    markers.current = createSeriesMarkers(view === "candles" ? cs : ls, own.map((trade) => ({ time: trade.t as UTCTimestamp, position: trade.is_buy ? "belowBar" as const : "aboveBar" as const,
      color: trade.is_buy ? colors.upColor : colors.downColor, shape: trade.is_buy ? "arrowUp" as const : "arrowDown" as const,
      text: `${trade.count > 1 ? `${trade.count} ` : ""}${trade.is_buy ? "buy" : "sell"}${trade.count > 1 ? "s" : ""}` })));
    const fitKey = `${chain}:${token}:${interval}:${range}`;
    if (series.length && fitted.current !== fitKey) { c.timeScale().fitContent(); fitted.current = fitKey; }
    else if (logicalRange && series.length) {
      // A rolling window drops leading bars. Keep the same timestamps under
      // the crosshair, including fractional zoom and whitespace at the edges.
      const shift = typeof previousFirst === "number" ? (series[0].t - previousFirst) / INTERVALS[interval] : 0;
      c.timeScale().setVisibleLogicalRange({ from: logicalRange.from - shift, to: logicalRange.to - shift });
    }
    if (!series.length) fitted.current = "";
  }, [prepared, series, data?.mine, interval, range, metric, currency, themeTick, view, volume, scale, autoScale, showTrades, hasWallet, chain, token]);

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
    const window = chart.current?.timeScale().getVisibleLogicalRange();
    if (window && (index < window.from || index > window.to)) {
      const width = window.to - window.from;
      chart.current?.timeScale().setVisibleLogicalRange(index < window.from ? { from: index, to: index + width } : { from: index - width, to: index });
    }
    chart.current?.setCrosshairPosition(bar.close / prepared.priceDivisor, bar.t as UTCTimestamp, (view === "candles" ? candles.current : line.current)!);
    setAnnouncement(`${utcTime(bar.t, true)} UTC. Open ${fmt(bar.open)}, high ${fmt(bar.high)}, low ${fmt(bar.low)}, close ${fmt(bar.close)} ${currency}. Volume ${formatChartPrice(bar.volume)} ${data?.quote.symbol}. ${bar.filled ? "No swaps in this bucket; carried price." : `${bar.trades} trades.`}`);
  }
  function resetZoom() { setScalePreference({ unit, automatic: true }); chart.current?.priceScale("right").applyOptions({ autoScale: true }); chart.current?.timeScale().fitContent(); }

  return (
    <section ref={panel} className={styles.terminal} aria-label={`${symbol} market chart`}>
      <header className={styles.header}>
        <div className={styles.marketIdentity}>
          <div className={styles.kicker}><ScanLine size={14} aria-hidden /><span>{symbol} <span className={styles.secondary}>/ {currency}</span></span><span className={styles.chain}>{CHAIN_SHORT[chain]}</span></div>
          <h2 className={styles.metric}>{metric === "mcap" ? "Market cap" : "Token price"}</h2>
          <div className={styles.priceLine}><strong title={latest ? String(latest.close) : undefined}>{latest ? fmt(latest.close, true) : "—"}</strong><span className={styles.denom}>{currency}</span></div>
          <div className={styles.change}>{stats?.change != null ? <ChangeChip v={stats.change} plain context="across the visible candles" /> : null}<span>{stats ? "Visible range" : data && !hasHistory ? "Awaiting first swap" : "Waiting for chart data"}</span></div>
        </div>
        <div className={styles.headerControls}>
          <ToggleGroup aria-label="Chart metric" value={[metric]} onValueChange={(values) => { if (values[0]) setMetric(values[0] as "mcap" | "price"); }}>
            <ToggleGroupItem value="price">Price</ToggleGroupItem><ToggleGroupItem value="mcap">Mcap</ToggleGroupItem>
          </ToggleGroup>
          <label className={styles.currencySelect}><span className="sr-only">Chart currency</span><select value={usd ? "usd" : "quote"} onChange={(event) => setDenomination(event.target.value as "usd" | "quote")}><option value="quote">{data?.quote.symbol ?? "Quote"}</option>{usdAvailable ? <option value="usd">USD</option> : null}</select><ChevronDown size={12} aria-hidden /></label>
        </div>
      </header>
      <div className={styles.toolbar}>
        <div className={styles.scrollTools}>
          <ToggleGroup aria-label="Chart interval" value={[interval]} onValueChange={(values) => { if (values[0]) onIntervalChange(values[0] as Interval); }} className={styles.intervals}>
            {INTERVAL_KEYS.map((key) => <ToggleGroupItem key={key} value={key} className={styles.interval}>{key === "1d" ? "1D" : key}</ToggleGroupItem>)}
          </ToggleGroup>
          <span className={styles.divider} />
          <button type="button" className={styles.tool} onClick={() => setView(view === "candles" ? "line" : "candles")} aria-label={view === "candles" ? "Switch to line chart" : "Switch to candlestick chart"} title={view === "candles" ? "Switch to line chart" : "Switch to candlestick chart"}>{view === "candles" ? <CandlestickChart size={17} aria-hidden /> : <LineChart size={17} aria-hidden />}<span>{view === "candles" ? "Candles" : "Line"}</span></button>
          <span className={styles.divider} />
          <button type="button" className={styles.tool} aria-pressed={volume} onClick={() => setVolume(!volume)}><ChartNoAxesColumn size={15} aria-hidden />Volume</button>
          <button type="button" className={styles.tool} aria-pressed={hasWallet && showTrades} disabled={!hasWallet} title={hasWallet ? "Show your latest 200 indexed trades within this range" : "Connect a wallet to show your trades"} onClick={() => setShowTrades(!showTrades)}>My trades</button>
        </div>
        <div className={styles.fixedTools}>
          <button type="button" className={styles.iconButton} onClick={onRefresh} disabled={loading} aria-label="Refresh chart data" title="Refresh chart data"><RefreshCw size={15} aria-hidden /></button>
          <button type="button" ref={fullscreenButton} className={styles.iconButton} onClick={() => void toggleFullscreen()} disabled={!fullscreenAvailable} aria-label={fullscreen ? "Exit chart fullscreen" : "Enter chart fullscreen"} title={fullscreenAvailable ? "Fullscreen chart" : "Fullscreen isn’t available in this browser"}>{fullscreen ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}</button>
        </div>
      </div>
      <div className={styles.legend} aria-live="off">
        <div className={styles.legendContext}><span>{symbol} / {currency} <span>· {interval} · Uniswap v4</span></span><time>{inspected ? `${utcTime(inspected.t, true)} UTC` : "—"}</time></div>
        <div className={styles.ohlc} data-direction={inspected && inspected.close !== inspected.open ? inspected.close > inspected.open ? "up" : "down" : "flat"}>
          {([ ["O", "open"], ["H", "high"], ["L", "low"], ["C", "close"] ] as const).map(([label, key]) => <span key={key} title={inspected ? `${key}: ${inspected[key]} ${currency}` : key}><b>{label}</b>{inspected ? formatChartPrice(inspected[key], true) : "—"}</span>)}
          <span className={styles.legendVolume}><b>Vol</b>{inspected ? formatChartPrice(inspected.volume, true) : "—"} <small>{data?.quote.symbol ?? "Quote"}</small></span>
          {inspected?.filled ? <span className={styles.carried}>Carried price · no swaps</span> : null}
        </div>
      </div>
      <div className={styles.plotWrap}>
        <div ref={box} className={styles.plot} tabIndex={0} role="group" aria-label={`${symbol} interactive ${metric === "mcap" ? "market cap" : "price"} chart, ${currency}`} aria-describedby={helpId}
          onPointerMove={() => { keyboardInspection.current = false; }}
          onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); inspectBar(event.key); } else if (event.key === "Escape" && !fullscreen) { keyboardInspection.current = false; chart.current?.clearCrosshairPosition(); setHoverTime(null); setAnnouncement("Showing the latest candle."); } }} />
        {loading && !data ? <div className={styles.overlay} aria-label="Loading chart"><Sk className="h-full w-full rounded-lg" /></div> : null}
        {error && !data ? <div className={`${styles.overlay} ${styles.empty}`} role="status"><strong>Chart data is unavailable</strong><p>Try loading the indexed history again.</p><button type="button" onClick={onRefresh}>Retry chart</button></div> : null}
        {prepared.unavailable ? <div className={`${styles.overlay} ${styles.empty}`} role="status"><strong>This history can’t be charted safely</strong><p>The returned values are invalid or exceed supported numeric precision.</p><button type="button" onClick={onRefresh}>Retry chart</button></div> : null}
        {!loading && !error && !prepared.unavailable && noWindowTrades ? <div className={styles.baselineNote}><span>{hasHistory ? "A quiet window" : "No trades yet"}</span><small>{hasHistory ? "Showing the last indexed price. No swaps in this range." : "Candles appear after the first indexed swap. A launch price is not trading history."}</small></div> : null}
      </div>
      <div className={styles.bottomToolbar}>
        <ToggleGroup aria-label="Chart date range" value={[range]} onValueChange={(values) => { if (values[0]) onRangeChange(values[0] as ChartRange); }} className={styles.ranges}>
          {RANGES.map(([value, label]) => <ToggleGroupItem key={value} value={value} title={value === "auto" ? "Default history for this interval" : `Load ${label === "All" ? "available" : label} history with a suitable interval`} className={styles.range}>{label}</ToggleGroupItem>)}
        </ToggleGroup>
        <div className={styles.scaleTools}>
          <button type="button" aria-label="Reset chart zoom" title="Fit loaded history and reset price scale" className={styles.iconButton} onClick={resetZoom}><LocateFixed size={15} aria-hidden /></button>
          <span className={styles.divider} />
          <button type="button" aria-label="Percentage price scale" aria-pressed={scale === "percent"} className={styles.scaleButton} onClick={() => setScale(scale === "percent" ? "normal" : "percent")}>%</button>
          <button type="button" aria-label="Logarithmic price scale" aria-pressed={scale === "log"} className={styles.scaleButton} onClick={() => setScale(scale === "log" ? "normal" : "log")}>log</button>
          <button type="button" aria-label="Automatic price scale" aria-pressed={autoScale} className={styles.scaleButton} onClick={() => setScalePreference({ unit, automatic: !autoScale })}>auto</button>
        </div>
      </div>
      <footer className={styles.footer}>
        <span>{error && data ? "Refresh failed. Showing the last snapshot." : loading && data ? "Refreshing indexed history…" : data ? `Snapshot ${utcTime(data.asOf)} UTC` : "Indexed Uniswap v4 swaps"}</span>
        <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer">Charts by TradingView ↗</a>
      </footer>
      <div className={styles.dataNote}>
        <span>Volume in {data?.quote.symbol ?? "quote units"}.{usd ? " USD prices use the current quote conversion, not historical rates." : ""}</span>
        {hasWallet && showTrades ? <span>Markers show your latest 200 indexed trades within this range.</span> : null}
        {data && range === "all" && data.from > data.launch.t + INTERVALS[interval] ? <span>History is capped at 2,000 candles.</span> : null}
      </div>
      <p id={helpId} className="sr-only">Use left and right arrows to inspect candles, Home and End for the first and last loaded candle. Escape clears inspection. Volume uses the pool quote currency. Filled gaps are carried prices, not executed trades.</p>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </section>
  );
}
