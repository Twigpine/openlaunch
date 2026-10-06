import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source=readFileSync(new URL("./TokenChart.tsx",import.meta.url),"utf8");
const page=readFileSync(new URL("../../app/t/[chain]/[token]/page.tsx",import.meta.url),"utf8");
const native=readFileSync(new URL("./TradingChart.tsx",import.meta.url),"utf8");
const loader=readFileSync(new URL("./PriceChart.tsx",import.meta.url),"utf8");
test("production passes exact pool identity, trade history and launch time",()=>{
  for(const value of ["poolId={l.pool_id}","quote={l.quote}","launchedAt={l.block_time}","hasTrades={l.buys + l.sells > 0}"]) assert.ok(page.includes(value));
  assert.doesNotMatch(page,/review=|chartPreview/);
});
test("primary chart is recoverable and on-chain fallback is lazy",()=>{
  for(const text of ['dynamic(() => import("./PriceChart")','setSource("onchain")',"fallbackReason","GeckoTerminal","onError={onError}","if (!hasTrades) return;"]) assert.ok(source.includes(text),text);
  assert.match(source,/referrerPolicy="no-referrer"/);
  assert.doesNotMatch(source,/allow-top-navigation|dangerouslySetInnerHTML|useAccount|contentWindow/);
});
test("blank iframe can be escaped and loading is not claimed as proof of candles",()=>{
  assert.match(source,/Blank chart\? Switch to On-chain/);
  assert.match(source,/may reset drawings/);
  assert.match(source,/active = false; clearTimeout\(timeout\); controller.abort\(\)/);
  assert.match(source,/return \(\) => clearTimeout\(timeout\)/);
  const frame = source.slice(source.indexOf("function ChartFrame("));
  assert.match(frame, /onLoad=\{\(\) => setState\("loaded"\)\}/);
  assert.match(frame, /current === "loading" \? "slow" : current/);
  assert.doesNotMatch(frame, /setLookup|setSource|postMessage|contentDocument|setState\("ready"\)/);
});
test("no trades shows no fabricated candles and can discover the first indexed swap",()=>{
  assert.match(native,/!data.baseline.hasPriorTrades && !data.candles.length/);
  assert.match(native,/No trades yet/);
  assert.match(loader,/onTradesFound\?\.\(\)/);
  assert.match(source,/onTradesFound=\{onTradesFound\}/);
});
test("preview cannot send wallet identity to public candle endpoint",()=>{
  assert.match(loader,/address && !reviewMode/);
  assert.match(loader,/process.env.NODE_ENV === "development" && review/);
});
