import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CHAINS, CHAIN_KEYS } from "../chainPublic";
import { BRIDGE_WALLET_CHAINS } from "./chains";
import { BRIDGE_CHAIN_IDS, BRIDGE_CHAINS } from "./types";

test("every bridge source has a matching wallet chain, and Arc is the registry's own chain", () => {
  for (const id of BRIDGE_CHAIN_IDS) {
    const walletChain = BRIDGE_WALLET_CHAINS[id];
    assert.equal(walletChain.id, id);
    assert.equal(walletChain.nativeCurrency.symbol, BRIDGE_CHAINS[id].symbol);
    assert.equal(walletChain.nativeCurrency.decimals, 18);
    assert.ok(walletChain.rpcUrls.default.http.length > 0);
  }
  // Elysium is a launchpad chain but not (yet) a bridge source: Relay serves it, the bridge dialog does not offer it
  assert.deepEqual(CHAIN_KEYS, ["base", "robinhood", "arc", "elysium"]);
  const arc = BRIDGE_WALLET_CHAINS[5042];
  assert.equal(arc, CHAINS.arc, "one Arc definition, shared by the launchpad and the bridge");
  assert.equal(arc.rpcUrls.default.http[0], "https://rpc.mainnet.arc.io");
  assert.equal(arc.blockExplorers.default.url, "https://explorer.arc.io");
  assert.equal(arc.nativeCurrency.symbol, "USDC");
  assert.notEqual(arc.id, 5042002);
});

test("wallet config registers Arc for switching and native-balance reads", () => {
  const config = readFileSync(new URL("../wagmi.ts", import.meta.url), "utf8");
  // every registry chain, Arc included, through the same proxied transport; the chain's own rpcUrls stay official for wallet_addEthereumChain
  assert.match(config, /const chains = keys\.map\(\(k\) => CHAINS\[k\]\)/);
  assert.match(config, /transports: Object\.fromEntries\(keys\.map\(\(k\) => \[CHAINS\[k\]\.id, http\(browserRpc\(k\)/);
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
