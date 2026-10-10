import assert from "node:assert/strict";
import { test } from "node:test";
import {
  explorerUrl,
  formatUnits,
  parseUnits,
  publicKey,
  solanaConfig,
  type Deployment,
} from "./config.ts";

const key = "So11111111111111111111111111111111111111112";
const blank: Deployment = {
  schema: 1,
  cluster: "mainnet-beta",
  genesisHash: null,
  programId: null,
  programData: null,
  sourceCommit: null,
  binarySha256: null,
  verifiedSlot: null,
  securityReview: null,
  economicReview: null,
  releaseApproved: false,
};
test("Solana stays disabled without a complete approved mainnet release", () => {
  assert.equal(solanaConfig({}, blank), null);
  assert.equal(
    solanaConfig(
      {
        SOLANA_ENABLED: "1",
        SOLANA_CLUSTER: "mainnet-beta",
        SOLANA_DEVNET_PROGRAM_ID: key,
      },
      blank,
    ),
    null,
  );
  assert.equal(
    solanaConfig(
      { SOLANA_ENABLED: "1", SOLANA_CLUSTER: "mainnet-beta" },
      { ...blank, releaseApproved: true, programId: key },
    ),
    null,
  );
  assert.equal(
    solanaConfig(
      {
        SOLANA_ENABLED: "1",
        SOLANA_CLUSTER: "devnet",
        SOLANA_DEVNET_PROGRAM_ID: key,
      },
      blank,
    )?.cluster,
    "devnet",
  );
});
test("addresses remain case-sensitive and reject default, spaces and malformed keys", () => {
  assert.equal(publicKey(key), key);
  assert.notEqual(publicKey(key.toLowerCase()), key);
  for (const bad of [` ${key}`, "11111111111111111111111111111111", "0x123"])
    assert.equal(publicKey(bad), null);
});
test("decimal amounts never round through floating point", () => {
  assert.equal(parseUnits("18446744073.709551615", 9), (1n << 64n) - 1n);
  assert.equal(
    formatUnits(parseUnits("1000000000.000001", 6), 6),
    "1000000000.000001",
  );
  for (const bad of [
    "1e9",
    "0",
    "-1",
    "1,000",
    "0.0000000001",
    "18446744073.709551616",
  ])
    assert.throws(() => parseUnits(bad, 9));
  assert.equal(
    explorerUrl("devnet", "address", key).endsWith("?cluster=devnet"),
    true,
  );
});
