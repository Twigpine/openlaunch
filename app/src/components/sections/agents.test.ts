import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/agents/page.tsx", import.meta.url), "utf8");
const codePanel = readFileSync(new URL("./AgentsCodeBlock.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./Agents.module.css", import.meta.url), "utf8");

// Source contracts protect the documentation's executable text and safety
// boundaries. Responsive geometry and clipboard interaction get browser review.
test("agent documentation preserves the original launch signature and example", () => {
  for (const literal of [
    'launch((string,string,string,address,uint256,int24,uint24,bytes32,(address,uint16)[]))',
    '(My Token,MYT,,0x0000000000000000000000000000000000000000,0,184200,10000,0x$(openssl rand -hex 32),[(0xYourWallet,10000)])',
    '--rpc-url https://mainnet.base.org --private-key $PK',
    'launch(params)', 'findSalt(...)', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    '10000 = 1%', '30000 = 3%', '184200 ≈ 10 ETH',
    '{chain, launcher, salt, name, symbol, description?, image_url?, website?, x_handle?}',
    'metadataURI', 'V4_SWAP', 'poolKeyOf(token)', 'collect(tokenId)',
  ]) assert.ok(page.includes(literal), `Missing contract reference: ${literal}`);
  assert.match(page, /Never share your private key/);
  assert.match(page, /Example only/);
});

test("agent documentation retains every public endpoint and configured chain", () => {
  for (const path of [
    '/api/launch/list?chain=base|robinhood|arc|elysium&sort=live|new|mcap|volume|gainers|holders&window=1h|24h|all&limit=50',
    '/api/launch/feed', '/api/launch/meta/<token>', '/llms.txt',
    '/api/launch/meta', '/api/launch/sync?chain=base|robinhood|arc|elysium&tx=0x…',
  ]) assert.ok(page.includes(path), `Missing endpoint: ${path}`);
  assert.match(page, /CHAIN_KEYS\.map/);
  assert.match(page, /config = launchpad\(chain\)/);
  assert.match(page, /\["factory", "locker"\]/);
  assert.match(page, /config\[contract\] \? <a href=\{explorerAddress\(chain, config\[contract\]\)\}/);
  assert.match(page, /not deployed yet/);
  assert.match(page, /CHAINS\[chain\]\.id/);
  assert.match(page, /href=\{BRAND_GITHUB\}/);
});

test("agent reference distinguishes quote units, unknown prices and indexing freshness", () => {
  for (const field of ['quote_decimals', 'price_quote', 'fdv_quote', 'price_usd', 'fdv_usd', 'volume_usd', 'null']) {
    assert.ok(page.includes(`<code>${field}</code>`), `Missing data convention: ${field}`);
  }
  assert.match(page, /Poll modestly and back off on errors/);
  assert.match(page, /not a guarantee of the latest chain state/);
  assert.match(page, /receipt availability and RPC errors can delay indexing/);
  assert.match(page, /issuer-registry stock token/);
  assert.match(page, /Regulation S, not to US persons/);
  assert.doesNotMatch(page, /floats in ETH|Poll freely|small and uncached|ETH \/ token/);
});

test("agent sections have native focus targets and accessible copy-only references", () => {
  for (const id of ['launch', 'read', 'trade']) {
    assert.ok(page.includes(`id: "${id}"`));
    assert.ok(page.includes(`<section id="${id}" tabIndex={-1}`));
  }
  assert.match(page, /aria-label="Agent documentation sections"/);
  assert.match(codePanel, /<button type="button" onClick=\{copy\}/);
  assert.match(codePanel, /navigator\.clipboard\.writeText\(code\)/);
  assert.match(codePanel, /catch\s*\{\s*setStatus\("error"\)/);
  assert.match(codePanel, /role="status"/);
  assert.match(codePanel, /Copy unavailable\. Select and copy the code instead/);
  assert.match(codePanel, /<pre tabIndex=\{0\} role="region" aria-label=/);
  assert.doesNotMatch(codePanel, /fetch\(|eval\(|new Function|writeContract|sendTransaction|useWallet|setInterval/);
  assert.doesNotMatch(page, /"use client"/);
});

test("agent code stays width-constrained and uses the existing flat theme", () => {
  assert.match(css, /grid-template-columns: 176px minmax\(0, 1fr\)/);
  assert.match(css, /\.code \{ max-width: 100%; min-width: 0;[^}]*overflow-x: auto/);
  assert.match(css, /\.copyButton \{[^}]*min-height: 44px/);
  assert.match(css, /\.network dd a \{[^}]*min-height: 44px/);
  assert.match(css, /\.code:focus-visible/);
  assert.match(css, /@media \(max-width: 479px\)/);
  assert.doesNotMatch(css, /box-shadow|text-shadow|gradient\(|animation:|#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(css, /background(?:-color)?: var\(--color-brand\)/);
  assert.doesNotMatch(page + codePanel + css, /font-display|font-unbounded|\u2014/);
});
