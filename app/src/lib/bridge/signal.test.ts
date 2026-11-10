import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_CHAIN_IDS } from "./types";
import { SIGNAL_CODES, SIGNAL_COLORS, SIGNAL_MIN_COLS, SIGNAL_ROWS, codeLights, glyphCells, routeLight, signalCaption, signalLayout, signalMode, signalPitch, type SignalMode } from "./signal";
import { parseBridgeLink, bridgeLinkKey, bridgeLinkPath } from "./link";
import { SLIDE_CONFIRM_AT, slideKey, slideProgress, slideRelease, slideTurns } from "./slide";

const MODES: SignalMode[] = ["idle", "quoting", "ready", "expired", "blocked", "approval", "wallet", "transit", "arrived", "refund", "attention"];
const base = { phase: "idle", tracked: false, approvalActive: false, quoteLoading: false, reviewing: false, quoteExpired: false, blocked: false } as const;

test("every bridge network has a board code the dot letters can spell, and its own light colour", () => {
  for (const id of BRIDGE_CHAIN_IDS) {
    const code = SIGNAL_CODES[id];
    assert.match(code, /^[A-Z]{2,4}$/, String(id));
    const glyph = glyphCells(code);
    assert.equal(glyph.width, code.length * 6 - 1);
    assert.ok(glyph.cells.length > code.length * 8, code);
    for (const [x, y] of glyph.cells) assert.ok(x >= 0 && x < glyph.width && y >= 0 && y < 7, code);
    assert.equal(SIGNAL_COLORS[id].length, 3);
  }
  assert.equal(new Set(BRIDGE_CHAIN_IDS.map((id) => SIGNAL_CODES[id])).size, BRIDGE_CHAIN_IDS.length, "no two networks share a code");
  assert.equal(SIGNAL_CODES[99901], "ELYS");
  assert.throws(() => glyphCells("XYZ"), /no letter/);
});

test("the board lays the two codes at the edges with a continuous route between them, inside its bounds", () => {
  for (const cols of [SIGNAL_MIN_COLS, 72, 96]) for (const from of BRIDGE_CHAIN_IDS) for (const to of BRIDGE_CHAIN_IDS) {
    if (from === to) continue;
    const layout = signalLayout(cols, SIGNAL_CODES[from], SIGNAL_CODES[to]);
    assert.equal(layout.rows, SIGNAL_ROWS);
    for (const [x, y] of [...layout.from, ...layout.to, ...layout.path]) assert.ok(x >= 0 && x < cols && y >= 0 && y < SIGNAL_ROWS, `${cols} ${from}->${to}`);
    assert.ok(layout.path.length >= 8, `${cols}: a route needs room`);
    const fromRight = Math.max(...layout.from.map(([x]) => x)), toLeft = Math.min(...layout.to.map(([x]) => x));
    assert.ok(layout.path[0][0] > fromRight && layout.path.at(-1)![0] < toLeft, "the route never overlaps a code");
    layout.path.forEach(([x], i) => { if (i) assert.equal(x, layout.path[i - 1][0] + 1); });
  }
  // a one-network step (an approval) shows no destination
  const single = signalLayout(72, "ARC", null);
  assert.equal(single.to.length, 0);
  assert.ok(single.path.length > 30);
});

test("dot spacing holds through a scrollbar's worth of width change, so the board cannot resize itself in a loop", () => {
  const first = signalPitch(390, null);
  assert.deepEqual(first, { pitch: 5, width: 390 });
  // a taller board adds a scrollbar (about 11px); the width it then reports must not change the spacing back
  assert.equal(signalPitch(401, first), first);
  assert.equal(signalPitch(379, first), first);
  assert.deepEqual(signalPitch(468, first), { pitch: 7, width: 468 });
  assert.equal(signalPitch(280, null).pitch, 4);
  assert.equal(signalPitch(120, null).pitch, 3);
  assert.equal(signalPitch(2000, null).pitch, 10);
  for (const width of [280, 320, 390, 424, 468, 560]) {
    const { pitch } = signalPitch(width, null);
    assert.ok(Math.floor(width / pitch) >= SIGNAL_MIN_COLS, `${width}px fits two codes and a route`);
  }
});

test("the board follows the transfer state and never shows movement the app cannot stand behind", () => {
  assert.equal(signalMode(base), "idle");
  assert.equal(signalMode({ ...base, quoteLoading: true }), "quoting");
  assert.equal(signalMode({ ...base, reviewing: true }), "ready");
  assert.equal(signalMode({ ...base, reviewing: true, quoteExpired: true }), "expired");
  assert.equal(signalMode({ ...base, blocked: true }), "blocked");
  // a wallet step outranks any quote; only a tracked, pending transfer is "in transit"
  assert.equal(signalMode({ ...base, reviewing: true, phase: "confirming" }), "wallet");
  assert.equal(signalMode({ ...base, reviewing: true, phase: "switching" }), "wallet");
  assert.equal(signalMode({ ...base, reviewing: true, approvalActive: true }), "approval");
  assert.equal(signalMode({ ...base, tracked: true, phase: "confirming" }), "wallet");
  assert.equal(signalMode({ ...base, tracked: true, phase: "pending" }), "transit");
  assert.equal(signalMode({ ...base, tracked: true, phase: "success" }), "arrived");
  assert.equal(signalMode({ ...base, tracked: true, phase: "refund" }), "refund");
  for (const phase of ["uncertain", "failure", "idle", "quoting", "review"] as const) assert.equal(signalMode({ ...base, tracked: true, phase }), "attention", phase);
  for (const phase of ["idle", "quoting", "review", "confirming", "switching", "uncertain", "failure", "refund"] as const) {
    assert.notEqual(signalMode({ ...base, tracked: false, phase }), "transit", phase);
    assert.notEqual(signalMode({ ...base, tracked: false, phase }), "arrived", phase);
  }
  assert.equal(signalCaption("arrived", "Base"), "Arrived on Base");
  for (const mode of MODES) assert.ok(signalCaption(mode, "Robinhood").length <= 20, mode);
});

test("lights stay within range, travel forward in transit, backward on a refund, and rest green on arrival", () => {
  for (const mode of MODES) for (let i = 0; i < 24; i++) for (const t of [0, 0.37, 1.9, 12.25]) {
    const light = routeLight(mode, t, i, 24);
    assert.ok(light.level >= 0 && light.level <= 1, `${mode} ${i} ${t}`);
    const codes = codeLights(mode, t);
    assert.ok(codes.from >= 0 && codes.from <= 1 && codes.to >= 0 && codes.to <= 1, mode);
  }
  const peak = (mode: SignalMode, t: number) => { let best = 0; for (let i = 1; i < 24; i++) if (routeLight(mode, t, i, 24).level > routeLight(mode, t, best, 24).level) best = i; return best; };
  // a pulse drags its trail behind it: toward the source when it runs forward, toward the destination on a refund
  const head = peak("ready", 1.6), back = peak("refund", 0.3);
  assert.ok(routeLight("ready", 1.6, head - 1, 24).level > routeLight("ready", 1.6, head + 1, 24).level, "a quote's pulse runs source to destination");
  assert.ok(routeLight("refund", 0.3, back + 1, 24).level > routeLight("refund", 0.3, back - 1, 24).level, "a refund runs back toward the source");
  assert.deepEqual(routeLight("arrived", 3, 5, 24), { level: 0.9, tone: "ok" });
  assert.equal(routeLight("refund", 1, 5, 24).tone, "warn");
  assert.equal(routeLight("attention", 1, 5, 24).tone, "warn");
  // waiting on the wallet lights only the source end: nothing has left
  assert.ok(routeLight("wallet", 0.4, 12, 24).level < 0.2 && routeLight("approval", 0.4, 20, 24).level < 0.2);
  assert.equal(codeLights("arrived", 0).toTone, "ok");
  assert.ok(codeLights("idle", 0).to < codeLights("arrived", 0).to, "the destination lights fully only on arrival");
});

test("sliding confirms only by letting go, or pressing Enter, at the far end", () => {
  assert.equal(slideProgress(160, 100, 10, 100), 0.5);
  assert.equal(slideProgress(40, 100, 10, 100), 0);
  assert.equal(slideProgress(900, 100, 10, 100), 1);
  assert.equal(slideProgress(160, 100, 10, 0), 0);
  assert.equal(slideProgress(Number.NaN, 100, 10, 100), 0);
  assert.equal(slideRelease(SLIDE_CONFIRM_AT), "confirm");
  assert.equal(slideRelease(SLIDE_CONFIRM_AT - 0.01), "reset");
  assert.equal(slideRelease(0), "reset");
  // arrows only move the coin, even at the end
  assert.deepEqual(slideKey(0.9, "ArrowRight"), { progress: 1, confirm: false });
  assert.deepEqual(slideKey(1, "ArrowRight"), { progress: 1, confirm: false });
  assert.deepEqual(slideKey(0, "ArrowLeft"), { progress: 0, confirm: false });
  assert.deepEqual(slideKey(0.3, "End"), { progress: 1, confirm: false });
  assert.deepEqual(slideKey(0.7, "Home"), { progress: 0, confirm: false });
  assert.deepEqual(slideKey(0.5, "Enter"), { progress: 0.5, confirm: false });
  assert.deepEqual(slideKey(1, "Enter"), { progress: 1, confirm: true });
  assert.deepEqual(slideKey(1, " "), { progress: 1, confirm: true });
  assert.equal(slideKey(1, "Tab"), null);
  let position = 0;
  for (let i = 0; i < 10; i++) position = slideKey(position, "ArrowRight")!.progress;
  assert.equal(position, 1, "ten steps reach the end without rounding drift");
  assert.equal(slideTurns(300, 58), 2);
  assert.equal(slideTurns(40, 58), 1);
});

test("a bridge link preselects a valid route and is ignored whole when anything in it is off", () => {
  assert.deepEqual(parseBridgeLink({ from: "arbitrum", to: "base", asset: "USDC", toAsset: "USDC" }), { originChainId: 42161, destinationChainId: 8453, originAsset: "USDC", destinationAsset: "USDC" });
  assert.deepEqual(parseBridgeLink({ from: "base", to: "robinhood", toAsset: "USDG" }), { originChainId: 8453, destinationChainId: 4663, destinationAsset: "USDG" });
  // `from` defaults to Base, or Ethereum when Base is the destination
  assert.deepEqual(parseBridgeLink({ to: "arc" }), { originChainId: 8453, destinationChainId: 5042 });
  assert.deepEqual(parseBridgeLink({ to: "base" }), { originChainId: 1, destinationChainId: 8453 });
  assert.deepEqual(parseBridgeLink({ from: "elysium", to: "base", asset: "USDC", toAsset: "ETH" }), { originChainId: 99901, destinationChainId: 8453, originAsset: "USDC", destinationAsset: "ETH" });
  assert.deepEqual(parseBridgeLink({ to: "elysium" }), { originChainId: 8453, destinationChainId: 99901 });
  for (const query of [{ to: "elysium", toAsset: "HYPE" }, { from: "elysium", to: "base", asset: "HYPE" }, { from: "elysium", to: "ethereum" }]) assert.equal(parseBridgeLink(query), null, JSON.stringify(query));
  for (const query of [
    {}, { from: "base" }, { to: "ethereum" }, { from: "base", to: "arbitrum" }, { from: "base", to: "base" }, { from: "polygon", to: "base" },
    { from: "base", to: "robinhood", toAsset: "USDC" }, { from: "arc", to: "base", asset: "ETH" }, { from: "base", to: "arc", asset: "usdc" },
    { from: ["base", "arc"], to: "robinhood" }, { from: "base", to: ["arc", "robinhood"] }, { from: "Base", to: "arc" }, { from: "8453", to: "arc" }, { from: "__proto__", to: "arc" },
  ]) assert.equal(parseBridgeLink(query), null, JSON.stringify(query));
  const link = { originChainId: 10, destinationChainId: 4663, originAsset: "USDC", destinationAsset: "USDG" } as const;
  assert.equal(bridgeLinkPath(link), "/bridge?from=optimism&to=robinhood&asset=USDC&toAsset=USDG");
  assert.deepEqual(parseBridgeLink(Object.fromEntries(new URLSearchParams(bridgeLinkPath(link).split("?")[1]))), link);
  assert.equal(bridgeLinkKey(null), "");
  assert.notEqual(bridgeLinkKey(link), bridgeLinkKey({ ...link, destinationAsset: "ETH" }));
});
