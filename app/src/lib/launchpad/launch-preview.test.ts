import { test } from "node:test";
import assert from "node:assert/strict";
import { previewAddress, previewLaunch } from "./launch-preview.ts";

const base = { chain: "base" as const, name: " Sky Whale ", symbol: "WHALE", description: " A gentle giant. ", image: "", banner: "", website: "https://skywhale.xyz", xHandle: "skywhale", fdvQuote: 9.246, quote: { key: "eth" as const, symbol: "ETH", decimals: 18, usd: 2725 }, lpFee: 10_000, launcher: null };

test("the preview row carries what the form knows and starts every market figure empty", () => {
  const r = previewLaunch(base);
  assert.equal(r.name, "Sky Whale");
  assert.equal(r.symbol, "WHALE");
  assert.equal(r.description, "A gentle giant.");
  assert.equal(r.website, "https://skywhale.xyz");
  assert.equal(r.x_handle, "skywhale");
  assert.equal(r.fdv_quote, 9.246);
  assert.equal(r.fdv_usd, 9.246 * 2725);
  assert.equal(r.price_quote, 9.246 / 1e9, "a fixed billion supply");
  assert.deepEqual([r.buys, r.sells, r.holders, r.change_from_launch], [0, 0, 0, 0]);
  assert.equal(r.live_tier, "new");
});

test("blank fields fall back to placeholders, and only https images, banners and sites are kept", () => {
  const r = previewLaunch({ ...base, name: "  ", symbol: "", description: "", image: "http://x.y/logo.png", banner: "javascript:alert(1)", website: "ftp://x.y", fdvQuote: null, quote: { ...base.quote, usd: null } });
  assert.equal(r.name, "Your token");
  assert.equal(r.symbol, "TICKER");
  assert.equal(r.description, null);
  assert.equal(r.image_url, null);
  assert.equal(r.banner_url, null);
  assert.equal(r.website, null);
  assert.equal(r.fdv_quote, 0);
  assert.equal(r.fdv_usd, null, "no dollar figure without a price");
});

test("the stand-in address is stable per ticker and always address-shaped", () => {
  assert.equal(previewAddress("WHALE"), previewAddress("WHALE"));
  assert.notEqual(previewAddress("WHALE"), previewAddress("DOTTIE"));
  for (const s of ["", "A", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"]) assert.match(previewAddress(s), /^0x[0-9a-f]{40}$/);
});
