import { test } from "node:test";
import assert from "node:assert/strict";
import { getMock } from "../db-mock.ts";
import { BASE_STOCKS, BASE_STOCK_REGISTRY_URL, searchBaseStocks } from "./baseStocks.ts";
import { baseStockList, ensureRegistry, refreshBaseRegistry, stockByAddress, stockIssued, stockList } from "./stocksServer.ts";

// The Base list lives in the module, so this file walks it through one timeline: static, grown, cached, failed, retried.
// fetch is mocked per URL: Coinbase's registry answers `reply`, anything else (Robinhood's registry) answers nothing useful.

const NEW = "0xb200000000000000000000abcdef0123456789aa";
const SPOOF = "0xb200000000000000000000abcdef0123456789ff";
const NVDA = "0xb20000000000000000000078ee7ce2fe4908108c";
const NFLX = "0xb20000000000000000000058b8c947e44011dfe6";
const coinbaseRow = (symbol: string, address: string, name: string) => ({ contract_address: address, symbol, name, decimals: 8 });

test("base list: static until a good registry read, then only grows; a failed read keeps it and is retried after a minute", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const warn = t.mock.method(console, "warn", () => {});
  const info = t.mock.method(console, "info", () => {});
  const coinbaseWarnings = () => warn.mock.calls.filter((c) => String(c.arguments[0]).includes("coinbase registry")).length; // Robinhood's registry warns on its own
  let reply: (url: string) => Response = () => Response.json({ tokens: [...BASE_STOCKS.filter((s) => s.symbol !== "COINc").map((s) => coinbaseRow(s.symbol, s.address, `${s.name}, Inc.`))] });
  const asked: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    asked.push(String(url));
    return String(url).startsWith(BASE_STOCK_REGISTRY_URL) ? reply(String(url)) : Response.json({ assets: [] });
  });

  // before any read: the static list, nothing fetched by a lookup
  const before = stockList("base");
  assert.equal(before.length, 146);
  assert.equal(stockByAddress("base", NEW), null);
  assert.deepEqual(asked, []);

  // today's registry (145, no COINc): nothing new, so the very same rows
  await refreshBaseRegistry();
  assert.deepEqual(asked, [BASE_STOCK_REGISTRY_URL]);
  assert.equal(stockList("base"), before);
  assert.ok(stockByAddress("base", BASE_STOCKS.find((s) => s.symbol === "COINc")!.address), "COINc stays though the registry leaves it out");
  assert.equal(stockByAddress("base", NFLX)?.name, "Netflix", "listed names are not replaced by the registry's");
  assert.equal(info.mock.callCount(), 0);

  // inside the 10 minutes: no read
  await refreshBaseRegistry();
  assert.equal(asked.length, 1);

  // Coinbase lists a new stock (and the reply also carries a second "NVDAc" at another address)
  reply = () => Response.json({ tokens: [coinbaseRow("NEWc", NEW, "New Robotics Corporation"), coinbaseRow("NVDAc", SPOOF, "NVIDIA Corporation")] });
  t.mock.timers.tick(10 * 60_000);
  await ensureRegistry(); // the page-data path starts it too
  await refreshBaseRegistry();
  assert.equal(asked.filter((u) => u === BASE_STOCK_REGISTRY_URL).length, 2);
  const grown = stockList("base");
  assert.equal(grown.length, 147);
  assert.deepEqual(stockByAddress("base", NEW), { chain: "base", address: NEW, symbol: "NEWc", name: "New Robotics", decimals: 8, logo: grown.find((s) => s.address === NEW)!.logo, priced: false });
  assert.ok(stockByAddress("base", NEW)!.logo?.startsWith("data:image/svg+xml,"));
  assert.equal(stockByAddress("base", SPOOF), null, "a second NVDAc is never a stock");
  assert.equal(stockByAddress("base", NVDA)?.priced, true);
  assert.equal(stockByAddress("base", NVDA), before.find((s) => s.address === NVDA), "rows already built are reused, not rebuilt");
  assert.deepEqual(searchBaseStocks("new", 13, baseStockList()).map((s) => s.symbol), ["NEWc"], "and search finds it");
  assert.match(String(info.mock.calls[0]?.arguments[0]), /added 1 Base stock\(s\): NEWc/);

  // the supply read covers the grown list
  getMock().b20Supply = Object.fromEntries(stockList("base").map((s) => [s.address, 0n]));
  assert.equal((await stockIssued("base")).get(NEW), false);

  // registry down after the next 10 minutes: the list stays as it is; the failure is retried after a minute, not per request
  reply = () => new Response("bad gateway", { status: 502 });
  t.mock.timers.tick(10 * 60_000);
  await refreshBaseRegistry();
  assert.equal(stockList("base"), grown);
  assert.equal(coinbaseWarnings(), 1);
  await refreshBaseRegistry();
  assert.equal(asked.filter((u) => u === BASE_STOCK_REGISTRY_URL).length, 3);
  // a reply that is not the registry counts as a failure too, and never shrinks the list
  reply = () => Response.json({ tokens: [] });
  t.mock.timers.tick(60_000);
  await refreshBaseRegistry();
  assert.equal(asked.filter((u) => u === BASE_STOCK_REGISTRY_URL).length, 4);
  assert.equal(stockList("base"), grown);
  assert.equal(coinbaseWarnings(), 2);
  // a later reply without NEWc does not remove it while the app runs
  reply = () => Response.json({ tokens: [coinbaseRow("NVDAc", NVDA, "NVIDIA Corporation")] });
  t.mock.timers.tick(60_000);
  await refreshBaseRegistry();
  assert.equal(asked.filter((u) => u === BASE_STOCK_REGISTRY_URL).length, 5);
  assert.equal(stockList("base"), grown);
  assert.ok(stockByAddress("base", NEW));

  // a registry over two pages: the second is fetched with the first page's token, and its stock is added
  const PAGED = "0xb200000000000000000000abcdef0123456789ab";
  reply = (url) => Response.json(url === BASE_STOCK_REGISTRY_URL ? { tokens: [coinbaseRow("NVDAc", NVDA, "NVIDIA")], next_page_token: "MHhi+/2=" } : { tokens: [coinbaseRow("PAGEc", PAGED, "Paged Stock Inc.")] });
  t.mock.timers.tick(10 * 60_000);
  await refreshBaseRegistry();
  assert.deepEqual(asked.slice(-2), [BASE_STOCK_REGISTRY_URL, `${BASE_STOCK_REGISTRY_URL}&page_token=MHhi%2B%2F2%3D`]);
  assert.equal(stockByAddress("base", PAGED)?.name, "Paged Stock");
  assert.equal(stockList("base").length, 148);
  // ...and when a later page fails, nothing from the read is used (the list stays, retried after a minute)
  const LOST = "0xb200000000000000000000abcdef0123456789ac";
  reply = (url) => (url === BASE_STOCK_REGISTRY_URL ? Response.json({ tokens: [coinbaseRow("LOSTc", LOST, "Lost")], next_page_token: "p2" }) : new Response("bad gateway", { status: 502 }));
  t.mock.timers.tick(10 * 60_000);
  await refreshBaseRegistry();
  assert.equal(stockByAddress("base", LOST), null);
  assert.equal(stockList("base").length, 148);
  assert.equal(coinbaseWarnings(), 3);
});

test("other chains never read Coinbase's registry and never see its stocks", async () => {
  assert.equal(stockByAddress("robinhood", NEW), null);
  assert.equal(stockByAddress("arc", NEW), null);
  assert.deepEqual(stockList("arc"), []);
});
