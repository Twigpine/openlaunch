import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const loader = readFileSync(new URL("./PriceChart.tsx", import.meta.url), "utf8");
const renderer = readFileSync(new URL("./TradingChart.tsx", import.meta.url), "utf8");

// Focused source contracts complement pure candle/helper tests and browser QA.
// They do not simulate canvas interaction, API responses, or wallet signatures.
test("chart results and failures remain scoped to token, interval, range, and wallet", () => {
  const requestKey = loader.match(/const requestKey = (.+);/)?.[1] ?? "";
  for (const field of ["chain", "token.toLowerCase()", "interval", "range", "address?.toLowerCase()"])
    assert.ok(requestKey.includes(field), `request identity must include ${field}`);
  assert.match(loader, /result\?\.key === requestKey \? result\.data : null/);
  assert.match(loader, /failure\?\.key === requestKey \? failure\.message : null/);
  assert.match(loader, /new AbortController\(\)/);
  assert.match(loader, /signal: controller\.signal/);
  assert.match(loader, /id !== generation\.current \|\| controller\.signal\.aborted/);
  const cleanup = loader.slice(loader.indexOf("const timer = setTimeout"), loader.indexOf("}, [load]);"));
  assert.match(cleanup, /clearTimeout\(timer\)/);
  assert.match(cleanup, /\.current\+\+/);
  assert.match(cleanup, /\.current\?\.abort\(\)/);
});

test("chart history uses the shared live clock with full reconciliation, not a new poller", () => {
  assert.match(loader, /useLive\(\)/);
  assert.match(loader, /subscribe\(\(snapshot\)/);
  assert.match(loader, /nowMs\(\) - lastFull\.current >= 60_000/);
  assert.match(loader, /ready\.current !== requestKey \|\| fetching\.current/);
  assert.match(loader, /item\.chain === chain && item\.token\.toLowerCase\(\) === token\.toLowerCase\(\)/);
  assert.match(loader, /chartRangeSelection\(range, launchT, now\)\.from/);
  // In the loader, setInterval is the React setter, not the global timer.
  assert.match(loader, /const \[interval, setInterval\] = useState/);
  assert.doesNotMatch(loader + renderer, /\b(?:window|globalThis)\.setInterval\s*\(/);
  assert.doesNotMatch(renderer, /\bsetInterval\s*\(/);
});

test("aligned requests delegate snapshot reconciliation without crossing request identities", () => {
  assert.match(loader, /bucketStart\(now, INTERVALS\[interval\]\)/);
  // Freshness ordering, empty corrections, and full wallet snapshot semantics
  // are exercised by chart-payload.test.ts rather than repeated inline here.
  assert.match(loader, /mergeChartPayload\(\s*current\?\.key === requestKey \? current\.data : null,\s*payload,\s*tailOnly\s*\)/);
  assert.match(renderer, /hasWallet && showTrades \? aggregateWalletMarkers/);
  assert.match(renderer, /trade\.count/);
  assert.match(renderer, /latest 200 indexed trades within this range/);
});

test("real history baselines and quiet ranges are not presented as executed trades", () => {
  assert.match(renderer, /fillCandles\(data\.candles, INTERVALS\[interval\], data\.from, data\.asOf, data\.baseline\.price\)/);
  assert.match(renderer, /data\?\.baseline\.hasPriorTrades/);
  assert.match(renderer, /Carried price · no swaps/);
  assert.match(renderer, /A launch price is not trading history/);
  assert.match(renderer, /Showing the last indexed price\. No swaps in this range/);
  assert.match(renderer, /selectedRangeStats\(series, visible\?\.from, visible\?\.to\)/);
  assert.match(renderer, /context=\{inspected \? "against the first candle in view" : "across the visible candles"\}/);
  // scrubbing compares against the same first candle the resting change uses, never a launch or all-time figure
  assert.match(renderer, /inspected\.close \/ stats\.open - 1/);
  assert.doesNotMatch(renderer, /\bMath\.random\s*\(|\bfaker\b|\bdemoCandles\b|\bmockCandles\b/);
});

test("chart currency conversion and quote volume are explicitly distinct", () => {
  assert.match(renderer, /Number\.isFinite\(data\.quote\.usd\) && data\.quote\.usd > 0/);
  assert.match(renderer, /const currency = usd \? "USD" : data\?\.quote\.symbol/);
  assert.match(renderer, /value: bar\.volume/);
  assert.match(renderer, /formatChartPrice\(inspected\.volume, true\)/);
  // dollar figures say how they were converted, wherever USD is showing
  assert.match(renderer, /\{usd \? \(\s*<Popover\.Root>/);
  assert.match(renderer, /Every candle is converted to USD at today’s \{data\?\.quote\.symbol\} price, not the rate at the time\./);
  // volume always carries the pool's quote unit beside the figure
  assert.equal((renderer.match(/<small>\{data\?\.quote\.symbol \?\? "Quote"\}<\/small>/g) ?? []).length, 2);
  assert.match(renderer, /formatChartAxis\(coordinate \* prepared\.priceDivisor\)/);
  assert.match(renderer, /formatChartAxis\(coordinate \* prepared\.volumeDivisor\)/);
  assert.doesNotMatch(renderer, /value:\s*bar\.volume\s*\*/);
});

test("every library data path uses safe coordinates while display and keyboard values retain their units", () => {
  assert.match(renderer, /const series = prepared\.display/);
  // the line, the candles and the volume strip all draw prepared.render, never the display values
  assert.equal((renderer.match(/setData\(prepared\.render\.map/g) ?? []).length, 3);
  assert.doesNotMatch(renderer, /setData\(series\.map/);
  // the fill's reference price is converted into the same canvas units as the line it colours
  assert.match(renderer, /anchor\.value \/ prepared\.priceDivisor/);
  assert.match(renderer, /setCrosshairPosition\(bar\.close \/ prepared\.priceDivisor/);
  assert.doesNotMatch(renderer, /localization:\s*\{[^}]*\bpriceFormatter:/, "global formatting would override each pane's unit restoration");
  assert.match(renderer, /prepared\.unavailable \?/);
});

test("the chart keeps library attribution, real view modes, and lifecycle cleanup", () => {
  assert.match(renderer, /from "lightweight-charts"/);
  for (const type of ["BaselineSeries", "CandlestickSeries", "HistogramSeries"])
    assert.ok(renderer.includes(`addSeries(${type}`), `${type} must be a real series`);
  assert.match(renderer, /PriceScaleMode\.Logarithmic/);
  // straight segments between real closes: a curved line would draw values no trade ever printed
  assert.match(renderer, /lineType: LineType\.Simple/);
  assert.doesNotMatch(renderer, /LineType\.Curved/);
  // the licence credit: the logo on the chart links to tradingview.com, and the site footer names TradingView
  assert.match(renderer, /attributionLogo: true/);
  assert.match(readFileSync(new URL("../Footer.tsx", import.meta.url), "utf8"), /Charts by <a href="https:\/\/www\.tradingview\.com\/"/);
  assert.match(renderer, /unsubscribeCrosshairMove\(onCrosshair\)/);
  assert.match(renderer, /unsubscribeVisibleTimeRangeChange\(onRange\)/);
  assert.match(renderer, /observer\.disconnect\(\)/);
  assert.match(renderer, /markers\.current\?\.detach\(\)/);
  assert.match(renderer, /c\.remove\(\)/);
});

test("rolling history and display changes preserve the viewed time window", () => {
  assert.match(renderer, /getVisibleLogicalRange\(\)/);
  assert.match(renderer, /\(series\[0\]\.t - previousFirst\) \/ INTERVALS\[interval\]/);
  assert.match(renderer, /const logical = index;/, "keyboard inspection moves along the loaded buckets");
  assert.match(renderer, /setVisibleLogicalRange\(\{ from: logicalRange\.from - shift, to: logicalRange\.to - shift \}\)/);
  const fitKey = renderer.match(/const fitKey = (.+);/)?.[1] ?? "";
  for (const field of ["chain", "token", "interval", "range"])
    assert.ok(fitKey.includes(field), `fit identity must include ${field}`);
  assert.doesNotMatch(fitKey, /metric|currency|view|volume|showTrades|scale/);
  // a new unit (metric, currency or canvas normalization) never keeps a price range dragged for the old one
  assert.match(renderer, /scaledUnit\.current !== unit \? \{ autoScale: true \} : \{\}/);
});

test("keyboard inspection and fullscreen retain focus and announce recoverable failures", () => {
  assert.match(renderer, /tabIndex=\{0\} role="group"/);
  assert.match(renderer, /aria-describedby=\{helpId\}/);
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "Escape"])
    assert.ok(renderer.includes(`"${key}"`), `keyboard inspection supports ${key}`);
  assert.match(renderer, /event\.preventDefault\(\)/);
  assert.match(renderer, /role="status" aria-live="polite"/);
  assert.match(renderer, /document\.fullscreenElement === panel\.current/);
  assert.match(renderer, /fullscreenButton\.current\?\.focus\(\)/);
  assert.match(renderer, /disabled=\{!fullscreenAvailable\}/);
  assert.match(renderer, /Your browser couldn’t open fullscreen/);
  assert.match(renderer, /Retry chart/);
  assert.match(renderer, /Refresh failed\. Showing the last snapshot/);
});

test("chart wallet controls are read-only and cannot initiate a trade or signature", () => {
  assert.match(loader, /query\.set\("wallet", address\)/);
  // the trade markers' control exists only with a connected wallet; nothing to show without one
  assert.match(renderer, /\{hasWallet \? <button [^>]*aria-pressed=\{showTrades\}/);
  assert.doesNotMatch(loader + renderer, /\b(?:useWriteContract|useSignMessage|useSendTransaction|writeContract|signMessage|sendTransaction|switchChain)\s*\(/);
  assert.doesNotMatch(loader + renderer, /method:\s*["'](?:POST|PUT|DELETE|PATCH)["']/);
});
