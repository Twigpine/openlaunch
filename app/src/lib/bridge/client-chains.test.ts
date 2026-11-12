import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CHAINS, CHAIN_KEYS, SITE_URL } from "../chainPublic";
import { BRIDGE_FUNDING_WALLET_CHAINS, BRIDGE_WALLET_CHAINS, bridgeFundingRpc } from "./chains";
import { BRIDGE_CHAIN_IDS, BRIDGE_CHAINS } from "./types";

test("every bridge source has a matching wallet chain, and Arc and Elysium are the registry's own chains", () => {
  for (const id of BRIDGE_CHAIN_IDS) {
    const walletChain = BRIDGE_WALLET_CHAINS[id];
    assert.equal(walletChain.id, id);
    assert.equal(walletChain.nativeCurrency.symbol, BRIDGE_CHAINS[id].symbol);
    assert.equal(walletChain.nativeCurrency.decimals, 18);
    assert.ok(walletChain.rpcUrls.default.http.length > 0);
  }
  // every launchpad chain is a bridge network, and the bridge reuses its wallet chain
  assert.deepEqual(CHAIN_KEYS, ["base", "robinhood", "arc", "elysium"]);
  for (const key of CHAIN_KEYS) assert.equal(BRIDGE_WALLET_CHAINS[CHAINS[key].id as keyof typeof BRIDGE_WALLET_CHAINS], CHAINS[key]);
  const elysium = BRIDGE_WALLET_CHAINS[99901];
  assert.equal(elysium.nativeCurrency.symbol, "HYPE");
  assert.equal(elysium.rpcUrls.default.http[0], "https://rpc.elysium.kinetiq.xyz");
  assert.equal(BRIDGE_CHAINS[99901].explorer, elysium.blockExplorers?.default.url);
  const arc = BRIDGE_WALLET_CHAINS[5042];
  assert.equal(arc, CHAINS.arc, "one Arc definition, shared by the launchpad and the bridge");
  assert.equal(arc.rpcUrls.default.http[0], "https://rpc.mainnet.arc.io");
  assert.equal(arc.blockExplorers.default.url, "https://explorer.arc.io");
  assert.equal(arc.nativeCurrency.symbol, "USDC");
  assert.notEqual(arc.id, 5042002);
});

test("wallet config registers Arc and the funding networks for switching and native-balance reads", () => {
  const config = readFileSync(new URL("../wagmi.ts", import.meta.url), "utf8");
  // every registry chain, Arc included, then the bridge's funding networks, all through the same-origin proxy; the
  // chains' own rpcUrls stay official for wallet_addEthereumChain
  assert.match(config, /const chains = \[\.\.\.keys\.map\(\(k\) => CHAINS\[k\]\), \.\.\.BRIDGE_FUNDING_WALLET_CHAINS\]/);
  assert.match(config, /\.\.\.keys\.map\(\(k\) => \[CHAINS\[k\]\.id, http\(browserRpc\(k\), \{ batch: true \}\)\]\)/);
  assert.match(config, /\.\.\.BRIDGE_FUNDING_IDS\.map\(\(id\) => \[id, http\(bridgeFundingRpc\(id\), \{ batch: true \}\)\]\)/);
  assert.equal(bridgeFundingRpc(1), `${SITE_URL}/api/rpc?chain=ethereum`);
  assert.equal(bridgeFundingRpc(42161), `${SITE_URL}/api/rpc?chain=arbitrum`);
  assert.equal(bridgeFundingRpc(10), `${SITE_URL}/api/rpc?chain=optimism`);
  assert.deepEqual(BRIDGE_FUNDING_WALLET_CHAINS.map((chain) => chain.id), [1, 42161, 10]);
  assert.doesNotMatch(config, /rpc\.mainnet\.arc\.io/);
  const hook = readFileSync(new URL("../../components/bridge/useBridge.ts", import.meta.url), "utf8");
  assert.match(hook, /chain:\s*BRIDGE_WALLET_CHAINS\[q\.originChainId\]/);
  assert.doesNotMatch(hook, /CHAINS\[BRIDGE_CHAINS/);
});

test("approval polling waits for a hash and restarts when the same journal gains one", () => {
  const hook = readFileSync(new URL("../../components/bridge/useBridge.ts", import.meta.url), "utf8");
  assert.match(hook, /const approvalHash = approval\?\.approvalHash;/);
  assert.match(hook, /if \(!address \|\| !approvalId \|\| !approvalHash\) return;/);
  assert.match(hook, /\[address, approvalId, approvalHash, approvalPollRevision, config\]/);
  assert.match(hook, /observed\.approvalHash !== approvalHash\) return;/);
  assert.match(hook, /pub\.getTransactionReceipt\(\{ hash: approvalHash \}\)/);
});
