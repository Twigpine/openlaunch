import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAddress } from "viem";
import { BASE_STOCKS, BASE_STOCK_MAX_FEED_AGE_S, BASE_STOCK_SEARCH_LIMIT, baseStockByAddress, BASE_STOCK_REGISTRY_URL, baseRegistryPageUrl, cleanStockName, feedUsd, isB20Address, isB20RpcError, issuedFromSupply, mergeBaseStocks, parseBaseRegistry, readBaseRegistry, parseRoundData, pricedBaseStocks, responseHasB20Error, searchBaseStocks, stockTileSvg, underlyingTicker } from "./baseStocks.ts";

const symbols = (list: readonly { symbol: string }[]) => list.map((s) => s.symbol);
/** The 13 stocks Chainlink publishes a "Coinbase <TICKER>" feed for on Base. */
const PRICED = ["AAPLc", "AMZNc", "COINc", "CRCLc", "GOOGLc", "INTCc", "METAc", "MSFTc", "MSTRc", "NVDAc", "SNDKc", "SPCXc", "TSLAc"];
const NFLX = "0xb20000000000000000000058b8c947e44011dfe6"; // NFLXc: in the registry, no feed

test("registry: 146 Coinbase stocks, unique symbols and lowercase B20 addresses, 8 decimals, plain names, sorted by ticker", () => {
  assert.equal(BASE_STOCKS.length, 146);
  assert.equal(new Set(BASE_STOCKS.map((s) => s.address)).size, 146);
  assert.equal(new Set(symbols(BASE_STOCKS)).size, 146);
  for (const s of BASE_STOCKS) {
    assert.equal(s.address, s.address.toLowerCase(), `${s.symbol} address stored lowercase`);
    assert.ok(isB20Address(s.address), `${s.symbol} is a B20 address`);
    assert.equal(s.decimals, 8);
    assert.match(s.symbol, /^[A-Z]{1,5}(\.[A-Z])?c$/, `${s.symbol}: a ticker ("U", "GOOGL", "BRK.B") and the issuer's "c"`);
    assert.match(s.name, /^[A-Za-z0-9 .&'!-]{2,40}$/, `${s.symbol} name is short plain text`);
  }
  const tickers = BASE_STOCKS.map((s) => underlyingTicker(s.symbol));
  assert.deepEqual(tickers, [...tickers].sort(), "rows are sorted by underlying ticker");
});

test("price feeds: 13 stocks have a Chainlink feed (unique, checksummed, an ordinary contract); the other 133 have none", () => {
  const priced = BASE_STOCKS.filter((s) => s.feed !== null);
  assert.deepEqual(symbols(priced), PRICED);
  assert.equal(new Set(priced.map((s) => s.feed!.toLowerCase())).size, 13);
  for (const s of priced) {
    assert.ok(isAddress(s.feed!, { strict: true }), `${s.symbol} feed passes the EIP-55 checksum (a mistyped character fails it)`);
    assert.ok(!isB20Address(s.feed!), "feed is a normal contract");
  }
  assert.equal(BASE_STOCKS.filter((s) => s.feed === null).length, 133);
  assert.ok(priced.length <= BASE_STOCK_SEARCH_LIMIT, "every priced stock fits on the picker's first page");
});

// Token addresses are stored lowercase, so no checksum guards them: this hash does. It covers symbol, address and feed of
// every row. When it fails, check the changed rows against Coinbase's list (api.coinbase.com/v1/tokenized-stocks) and
// against Base (symbol() and decimals() at the address), then put the new hash here.
test("registry digest: a row changes only together with this hash", () => {
  const digest = createHash("sha256").update(BASE_STOCKS.map((s) => `${s.symbol} ${s.address} ${s.feed ?? "-"}`).join("\n")).digest("hex");
  assert.equal(digest, "e41ed6ad7a323c9156d67028b96b26cb0aa2c3f37ef571886a162ffaeb8664c4");
});

test("baseStockByAddress is case-insensitive and rejects unknown/lookalike addresses", () => {
  assert.equal(baseStockByAddress("0xb20000000000000000000078ee7ce2fE4908108C")?.symbol, "NVDAc");
  assert.equal(baseStockByAddress("0xB20000000000000000000078EE7CE2FE4908108C")?.symbol, "NVDAc");
  assert.equal(baseStockByAddress("0xb20000000000000000000078ee7ce2fe4908108d"), null, "one nibble off");
  assert.equal(baseStockByAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"), null, "USDG is not a stock");
  // stocks added with the full list: one a launch was already quoted in, one spelled the way Coinbase's API spells it
  assert.equal(baseStockByAddress("0xb2000000000000000000008d5328e9208773dc58")?.symbol, "NVOc");
  assert.equal(baseStockByAddress("0xB200000000000000000000082f7FEA8F2eE8f438")?.symbol, "BJc");
  assert.equal(baseStockByAddress(NFLX)?.name, "Netflix");
  assert.equal(baseStockByAddress("0xb200000000000000000000c85a31389d71f3ecfb")?.symbol, "COINc", "kept: live launches are quoted in it");
  assert.equal(baseStockByAddress("0xb2000000000000000000004c27f6523082f41d01"), null, "a live B20 token on Base that Coinbase did not issue");
});

test("isB20Address: prefix only, never a stock decision", () => {
  assert.equal(isB20Address("0xb200000000000000000000ffffffffffffffffff"), true, "unknown B20 → shape ok, registry says no");
  assert.equal(baseStockByAddress("0xb200000000000000000000ffffffffffffffffff"), null);
  assert.equal(isB20Address("0xb2000000000000000000000000000000000000000"), false, "41 chars");
  assert.equal(isB20Address("0x0000000000000000000000000000000000000000"), false);
});

test("searchBaseStocks: ticker, full symbol or company name; $ tolerated; capped", () => {
  assert.deepEqual(symbols(searchBaseStocks("nvda")), ["NVDAc"]);
  assert.deepEqual(symbols(searchBaseStocks("nvdac")), ["NVDAc"], "the full symbol, issuer suffix included");
  assert.deepEqual(symbols(searchBaseStocks("$TSLA")), ["TSLAc"]);
  assert.deepEqual(symbols(searchBaseStocks("apple")), ["AAPLc"]);
  assert.deepEqual(symbols(searchBaseStocks("netflix")), ["NFLXc"]);
  assert.deepEqual(symbols(searchBaseStocks(" Berkshire ")), ["BRK.Bc"]);
  assert.deepEqual(symbols(searchBaseStocks("brk.b")), ["BRK.Bc"]);
  assert.deepEqual(symbols(searchBaseStocks("papa john's")), ["PZZAc"], "apostrophes are the plain ASCII one");
  assert.equal(searchBaseStocks("").length, 12, "empty query lists up to the cap");
  assert.equal(searchBaseStocks("", 500).length, 146, "and the whole registry when the cap allows");
  assert.equal(searchBaseStocks("zzz").length, 0);
});

test("searchBaseStocks ranks: symbol prefix, then substring; priced stocks lead within each, the rest keep ticker order", () => {
  // an empty search is the picker's first page: exactly the stocks with a live USD price, then the rest by ticker
  assert.deepEqual(symbols(searchBaseStocks("", BASE_STOCK_SEARCH_LIMIT)), PRICED);
  assert.deepEqual(symbols(searchBaseStocks("", 500).slice(13, 16)), ["AAOIc", "AEOc", "AMCc"]);
  // a one-letter ticker is found by its letter, ahead of every longer ticker that starts with it
  assert.deepEqual(symbols(searchBaseStocks("u").slice(0, 5)), ["Uc", "UBERc", "ULc", "UNHc", "USDEc"]);
  assert.deepEqual(symbols(searchBaseStocks("w").slice(0, 3)), ["Wc", "WDCc", "WENc"]);
  assert.equal(searchBaseStocks("uc")[0].symbol, "Uc");
  // three prefixes in ticker order, then substring matches with the priced one (AAPL) first
  assert.deepEqual(symbols(searchBaseStocks("pl").slice(0, 4)), ["PLc", "PLNTc", "PLTRc", "AAPLc"]);
  // among prefixes the priced stocks lead, the rest keep ticker order
  assert.deepEqual(symbols(searchBaseStocks("a").slice(0, 4)), ["AAPLc", "AMZNc", "AAOIc", "AEOc"]);
  // every symbol ends in the issuer's "c": a "c" must not match all 146 by that suffix
  const c = symbols(searchBaseStocks("c", 500));
  assert.deepEqual(c.slice(0, 3), ["COINc", "CRCLc", "CAKEc"]);
  assert.ok(c.length < 146 && !c.includes("Uc") && !c.includes("NFLXc"));
});

test("pricedBaseStocks: a price is read only for registry stocks that have a feed", () => {
  const nvda = "0xB20000000000000000000078EE7CE2FE4908108C";
  const unknown = "0xb200000000000000000000ffffffffffffffffff";
  assert.deepEqual(symbols(pricedBaseStocks([nvda, NFLX, unknown, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"])), ["NVDAc"]);
  assert.deepEqual(pricedBaseStocks([NFLX, unknown]), [], "no feed, or not in the registry: nothing to read");
  assert.deepEqual(pricedBaseStocks([]), []);
  assert.deepEqual(symbols(pricedBaseStocks(BASE_STOCKS.map((s) => s.address))), PRICED);
});

test("parseRoundData decodes latestRoundData words and negative answers", () => {
  const w = (n: bigint) => (n < 0n ? (n + (1n << 256n)).toString(16) : n.toString(16)).padStart(64, "0");
  const hex = "0x" + w(1n) + w(22996000000n) + w(1_700_000_000n) + w(1_700_000_100n) + w(1n);
  assert.deepEqual(parseRoundData(hex), { answer: 22996000000n, updatedAt: 1_700_000_100 });
  assert.equal(parseRoundData("0x" + w(1n) + w(-5n) + w(0n) + w(1n) + w(1n))?.answer, -5n);
  assert.equal(parseRoundData("0x1234"), null);
});

test("feedUsd: 8-dec answer → USD; stale, future, zero or negative → null", () => {
  const now = 1_700_100_000;
  assert.equal(feedUsd({ answer: 22996000000n, updatedAt: now - 3600 }, now), 229.96);
  assert.equal(feedUsd({ answer: 22996000000n, updatedAt: now - 2 * 24 * 3600 }, now), 229.96, "weekend hold is fine");
  assert.equal(feedUsd({ answer: 22996000000n, updatedAt: now - BASE_STOCK_MAX_FEED_AGE_S - 1 }, now), null, "too old");
  assert.equal(feedUsd({ answer: 22996000000n, updatedAt: now + 60 }, now), null, "future round (clock skew / bad RPC) is not a price");
  assert.equal(feedUsd({ answer: 22996000000n, updatedAt: now + BASE_STOCK_MAX_FEED_AGE_S }, now), null, "far-future round is not a price either");
  assert.equal(feedUsd({ answer: 0n, updatedAt: now }, now), null);
  assert.equal(feedUsd({ answer: -1n, updatedAt: now }, now), null);
  assert.equal(feedUsd(null, now), null);
});

test("cleanStockName: the issuer's name the way the list writes it", () => {
  const cases: [string, string][] = [
    ["Tesla Inc.", "Tesla"],
    ["Advanced Micro Devices, Inc.", "Advanced Micro Devices"],
    ["Eli Lilly & Co", "Eli Lilly"],
    ["Berkshire Hathaway Inc. Class B", "Berkshire Hathaway Class B"],
    ["Eastman Kodak Company", "Eastman Kodak"],
    ["The Hershey Company", "The Hershey Company"],
    ["Papa John\u2019s International, Inc.", "Papa John's International"],
    ["Novo Nordisk A/S", "Novo Nordisk"],
    ["Anheuser-Busch InBev SA/NV", "Anheuser-Busch InBev"],
    ["Banco Santander, S.A.", "Banco Santander"],
    ["Planet Labs PBC", "Planet Labs"],
    ["Arm Holdings plc", "Arm Holdings"],
    ["  Sea   Limited ", "Sea"],
  ];
  for (const [raw, want] of cases) assert.equal(cleanStockName(raw), want, raw);
  assert.equal(cleanStockName("A".repeat(60)).length, 40);
});

// one row of Coinbase's reply (api.coinbase.com/v1/tokenized-stocks), trimmed to the fields that are read
const row = (symbol: string, address: string, extra: Record<string, unknown> = {}) => ({ contract_address: address, symbol, name: `${symbol.slice(0, -1)} Holdings, Inc.`, decimals: 8, isin: "US0000000000", ...extra });
const NEW = "0xb200000000000000000000AbCdEf0123456789aa"; // a B20 address the static list does not have
const NVDA = BASE_STOCKS.find((s) => s.symbol === "NVDAc")!;

test("parseBaseRegistry: keeps well-formed B20 stock rows, lowercased, with no feed; drops everything else", () => {
  const rows = parseBaseRegistry({
    tokens: [
      row("NEWc", NEW),
      row("NEWc", "0xb200000000000000000000abcdef0123456789bb"), // repeated symbol: the first wins
      row("DUPc", NEW), // repeated address
      row("BADc", "0x1234567890123456789012345678901234567890"), // not B20
      row("NVDA", "0xb200000000000000000000abcdef0123456789cc"), // no issuer "c"
      row("nvdac", "0xb200000000000000000000abcdef0123456789cd"),
      row("TOOLONGc", "0xb200000000000000000000abcdef0123456789ce"),
      row("DECc", "0xb200000000000000000000abcdef0123456789cf", { decimals: 19 }),
      row("DECc", "0xb200000000000000000000abcdef0123456789d0", { decimals: "8" }), // numeric string: accepted, and DECc is free again
      row("ODDc", "0xb200000000000000000000abcdef0123456789d1", { name: "<img src=x onerror=alert(1)>" }),
      row("NONc", "0xb200000000000000000000abcdef0123456789d2", { name: 42 }),
      null,
      "row",
    ],
  });
  assert.deepEqual(rows, [
    { symbol: "NEWc", name: "NEW Holdings", address: NEW.toLowerCase(), feed: null, decimals: 8 },
    { symbol: "DECc", name: "DEC Holdings", address: "0xb200000000000000000000abcdef0123456789d0", feed: null, decimals: 8 },
    { symbol: "ODDc", name: "ODD", address: "0xb200000000000000000000abcdef0123456789d1", feed: null, decimals: 8 },
    { symbol: "NONc", name: "NON", address: "0xb200000000000000000000abcdef0123456789d2", feed: null, decimals: 8 },
  ]);
  for (const junk of [null, 42, "x", [], { tokens: "x" }, { data: [row("NEWc", NEW)] }]) assert.deepEqual(parseBaseRegistry(junk), [], JSON.stringify(junk));
  // decimals must be a whole number or a string of digits: Number() would read null, "" and false as 0, true as 1, [8] as 8
  for (const decimals of [null, undefined, "", " ", false, true, [8], 8.5, "8.0", "-1", -1, 19, "x"]) {
    assert.deepEqual(parseBaseRegistry({ tokens: [row("NEWc", NEW, { decimals })] }), [], `decimals ${JSON.stringify(decimals)}`);
  }
  assert.equal(parseBaseRegistry({ tokens: [row("NEWc", NEW, { decimals: 0 })] })[0]?.decimals, 0, "a real 0 is still a number");
  assert.deepEqual(parseBaseRegistry({ tokens: Array.from({ length: 1001 }, () => row("NEWc", NEW)) }), [], "a reply far larger than the registry is not the registry");
});

test("mergeBaseStocks: the registry can only add; it never relabels, unprices or shadows a listed stock", () => {
  assert.equal(mergeBaseStocks(BASE_STOCKS, []), BASE_STOCKS);
  assert.equal(mergeBaseStocks(BASE_STOCKS, BASE_STOCKS.map((s) => ({ ...s, name: "Renamed", feed: null }))), BASE_STOCKS, "every address known: same list back, static names and feeds untouched");
  const added = { symbol: "NEWc", name: "New", address: NEW.toLowerCase(), feed: null, decimals: 8 };
  const spoof = { ...added, symbol: "NVDAc", address: "0xb200000000000000000000abcdef0123456789ff" };
  const lower = { ...added, symbol: "aaplc", address: "0xb200000000000000000000abcdef0123456789fe" }; // AAPLc in other case
  const merged = mergeBaseStocks(BASE_STOCKS, [spoof, added, lower, { ...NVDA, name: "Not Nvidia", feed: null }]);
  assert.equal(merged.length, BASE_STOCKS.length + 1, "only the new stock");
  assert.ok(merged.includes(added));
  assert.equal(merged.find((s) => s.symbol === "NVDAc"), NVDA, "NVDAc stays the listed row, feed and all");
  assert.ok(!merged.some((s) => s.address === spoof.address), "a second NVDAc at another address is dropped");
  const tickers = merged.map((s) => underlyingTicker(s.symbol));
  assert.deepEqual(tickers, [...tickers].sort(), "still sorted by ticker");
  assert.equal(mergeBaseStocks(merged, [added]), merged, "already there: nothing new");
  // two new rows for one stock (say, across registry pages): the first wins, by address and by symbol
  const twice = mergeBaseStocks(BASE_STOCKS, [added, { ...added }, { ...added, name: "Other", address: "0xb200000000000000000000abcdef0123456789fd" }]);
  assert.equal(twice.length, BASE_STOCKS.length + 1);
  assert.equal(twice.find((s) => s.symbol === "NEWc"), added);
});

test("readBaseRegistry: follows next_page_token through every page; a partial or looping read throws instead of passing for the registry", async () => {
  assert.equal(baseRegistryPageUrl(null), BASE_STOCK_REGISTRY_URL);
  assert.equal(baseRegistryPageUrl("ab+/="), `${BASE_STOCK_REGISTRY_URL}&page_token=ab%2B%2F%3D`, "the token is URL-encoded");
  const NEW2 = "0xb200000000000000000000abcdef0123456789bb";
  const pages: Record<string, unknown> = {
    first: { tokens: [row("NEWc", NEW), row("AAPLc", BASE_STOCKS[1].address)], next_page_token: "p2" },
    p2: { tokens: [row("NEXc", NEW2), row("NEWc", NEW)], next_page_token: "" },
  };
  const asked: (string | null)[] = [];
  const rows = await readBaseRegistry(async (token) => {
    asked.push(token);
    return pages[token ?? "first"];
  });
  assert.deepEqual(asked, [null, "p2"]);
  assert.deepEqual(rows.map((r) => r.symbol), ["NEWc", "AAPLc", "NEXc"], "both pages, NEWc once");
  for (const end of [undefined, null, ""]) assert.equal((await readBaseRegistry(async () => ({ tokens: [row("NEWc", NEW)], next_page_token: end }))).length, 1, `next_page_token ${JSON.stringify(end)} ends it`);

  const fails = async (name: string, getPage: (token: string | null) => Promise<unknown>, message: RegExp) => assert.rejects(readBaseRegistry(getPage), message, name);
  await fails("a page without a token list", async (t) => (t === null ? { tokens: [], next_page_token: "p2" } : { error: "rate limited" }), /page 2 has no token list/);
  await fails("a token that comes round again", async (t) => ({ tokens: [], next_page_token: t === "a" ? "b" : "a" }), /repeated next_page_token/);
  await fails("a token that is not a string", async () => ({ tokens: [], next_page_token: 7 }), /bad or repeated next_page_token/);
  let n = 0;
  await fails("more than 10 pages", async () => ({ tokens: [], next_page_token: `p${++n}` }), /more than 10 pages/);
  await fails("more than 1000 rows in all", async (t) => ({ tokens: Array.from({ length: 600 }, () => row("NEWc", NEW)), next_page_token: t === null ? "p2" : undefined }), /more than 1000 rows/);
  await fails("a failed page fetch", async (t) => { if (t) throw new Error("base registry 502"); return { tokens: [], next_page_token: "p2" }; }, /502/);
  assert.equal(n, 10, "stopped at the tenth page");
});

test("issuedFromSupply: supply above zero is issued, zero is not, a failed or odd read says nothing", () => {
  const [a, b, c, d] = BASE_STOCKS.slice(0, 4).map((s) => s.address);
  const out = issuedFromSupply([a.toUpperCase().replace("0X", "0x"), b, c, d], [
    { status: "success", result: 12_345n },
    { status: "success", result: 0n },
    { status: "failure" },
    { status: "success", result: "0" },
  ]);
  assert.deepEqual(Object.fromEntries(out), { [a]: true, [b]: false }, "keys are lowercase; c failed and d is not a uint");
  assert.equal(issuedFromSupply([a, b], [{ status: "success", result: 1n }]).has(b), false, "a missing read says nothing");
});

test("B20 RPC error detection (single + batch)", () => {
  assert.equal(isB20RpcError("EVM error OpcodeNotFound"), true);
  assert.equal(isB20RpcError("execution reverted"), false);
  assert.equal(isB20RpcError(undefined), false);
  assert.equal(responseHasB20Error({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "EVM error OpcodeNotFound" } }), true);
  assert.equal(responseHasB20Error([{ id: 1, result: "0x" }, { id: 2, error: { message: "EVM error OpcodeNotFound" } }]), true);
  assert.equal(responseHasB20Error([{ id: 1, result: "0x" }, { id: 2, error: { message: "execution reverted" } }]), false);
  assert.equal(responseHasB20Error({ id: 1, result: "0x" }), false);
  assert.equal(responseHasB20Error(null), false);
});

test("stockTileSvg: inline SVG data URL, blue tile, underlying ticker, safe against odd input", () => {
  const u = stockTileSvg("NVDAc");
  assert.ok(u.startsWith("data:image/svg+xml,"));
  const svg = decodeURIComponent(u.slice("data:image/svg+xml,".length));
  assert.ok(svg.includes('fill="#0052FF"'), "Base blue");
  assert.ok(svg.includes(">NVDA<"), "underlying ticker, no trailing c");
  assert.equal(underlyingTicker("GOOGLc"), "GOOGL");
  for (const s of BASE_STOCKS) assert.ok(decodeURIComponent(stockTileSvg(s.symbol)).includes(`>${underlyingTicker(s.symbol)}<`), s.symbol);
  assert.ok(decodeURIComponent(stockTileSvg("Uc")).includes(">U<"), "a one-letter ticker");
  assert.ok(decodeURIComponent(stockTileSvg("BRK.Bc")).includes(">BRK.B<"), "a class share keeps its dot");
  assert.ok(Math.max(...BASE_STOCKS.map((s) => stockTileSvg(s.symbol).length)) < 600, "every tile stays small");
  assert.ok(decodeURIComponent(stockTileSvg("<script>c")).includes(">SCRIP<"), "markup stripped (and capped at 5), never injected");
  assert.ok(decodeURIComponent(stockTileSvg("")).includes(">?<"));
  assert.ok(u.length < 600, "small enough to inline everywhere");
});
