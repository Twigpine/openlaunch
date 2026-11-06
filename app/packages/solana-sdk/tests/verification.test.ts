import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";
import { programDataAddress } from "../src/accounts.ts";
import { CLUSTER_GENESIS, validateDeploymentManifest, verifyDeploymentBytes } from "../src/verification.ts";

test("release identity must be explicit, not compile fixture or unreviewed defaults", async () => {
  const programId = new PublicKey(new Uint8Array(32).fill(7));
  const manifest = { schema: 1, cluster: "devnet", programId: programId.toBase58(), programData: (await programDataAddress(programId)).toBase58(), genesisHash: CLUSTER_GENESIS.devnet, sourceCommit: "a".repeat(40), binarySha256: "b".repeat(64), verifiedSlot: null, securityReview: null, economicReview: null, releaseApproved: false };
  assert.equal((await validateDeploymentManifest(manifest)).releaseApproved, false);
  await assert.rejects(validateDeploymentManifest({ ...manifest, releaseApproved: true }), /review evidence/);
  await assert.rejects(validateDeploymentManifest({ ...manifest, programId: "Fg6PaFpoGXkYsidMpWxTWqkZPknxNpEMTZfkhHQjBcqr" }), /fixture/);
  await assert.rejects(validateDeploymentManifest({ ...manifest, genesisHash: null }));
  await assert.rejects(validateDeploymentManifest({ ...manifest, programData: programId.toBase58() }));
  // The declared cluster and the genesis hash must agree, or verify-manifest would label one cluster's evidence as another's.
  await assert.rejects(validateDeploymentManifest({ ...manifest, cluster: "mainnet-beta" }), /declared cluster/);
  await assert.rejects(validateDeploymentManifest({ ...manifest, genesisHash: new PublicKey(new Uint8Array(32).fill(8)).toBase58() }), /declared cluster/);
  assert.equal((await validateDeploymentManifest({ ...manifest, cluster: "mainnet-beta", genesisHash: CLUSTER_GENESIS["mainnet-beta"] })).cluster, "mainnet-beta");
});
test("deployed ELF requires exact reviewed hash/bytes and only zero allocation padding", () => {
  const elf = Buffer.alloc(100); elf.set([0x7f, 0x45, 0x4c, 0x46]);
  const hash = Buffer.from(sha256(elf)).toString("hex");
  const data = Buffer.concat([Buffer.alloc(45), elf, Buffer.alloc(200)]);
  assert.equal(verifyDeploymentBytes(data, elf, hash), hash);
  assert.throws(() => verifyDeploymentBytes(data, elf, "a".repeat(64)), /SHA-256/);
  data[50] ^= 1; assert.throws(() => verifyDeploymentBytes(data, elf, hash), /differ/); data[50] ^= 1;
  data[data.length - 1] = 1; assert.throws(() => verifyDeploymentBytes(data, elf, hash), /differ/);
  assert.throws(() => verifyDeploymentBytes(Buffer.alloc(50), elf, hash), /differ/);
});
