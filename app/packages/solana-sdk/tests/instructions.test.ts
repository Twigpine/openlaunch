import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "buffer";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram, Transaction, type Blockhash } from "@solana/web3.js";
import { buildActivateLaunchInstruction, buildBuyInstruction, buildCancelPreparationInstruction, buildClaimFeesInstruction, buildCreateAssociatedTokenInstruction, buildPrepareLaunchInstruction, buildSellInstruction } from "../src/instructions.ts";
import { derivePoolAddresses, programDataAddress, TOKEN_PROGRAM_ID } from "../src/accounts.ts";
import { discriminator, Reader } from "../src/encoding.ts";
import { MAX_TRANSACTION_BYTES } from "../src/transactions.ts";

const programId = new PublicKey("Fg6PaFpoGXkYsidMpWxTWqkZPknxNpEMTZfkhHQjBcqr");
const creator = (await Keypair.fromSeed(new Uint8Array(32).fill(1))).publicKey;
const base = { creator, nonce: 7n, virtualSol: 30_000_000_000n, feeBps: 0, recipients: [], name: "Example", symbol: "EX", uri: "", contentHash: new Uint8Array(32) };
async function size(...ix: Awaited<ReturnType<typeof buildBuyInstruction>>[]) { return (await new Transaction({ feePayer: creator, recentBlockhash: "11111111111111111111111111111111" as Blockhash }).add(...ix).serialize({ requireAllSignatures: false, verifySignatures: false })).length; }
test("six instruction discriminators, exact args/account order and signer flags", async () => {
  const prepare = await buildPrepareLaunchInstruction(programId, base);
  assert.ok(Buffer.from(prepare.data.subarray(0, 8)).equals(discriminator("global", "prepare_launch")));
  const reader = new Reader(prepare.data.subarray(8));
  assert.equal(reader.long(), 7n); assert.equal(reader.long(), 30_000_000_000n); assert.equal(reader.short(), 0);
  assert.equal(reader.text(32), "Example"); assert.equal(reader.text(10), "EX"); assert.equal(reader.text(200, true), "");
  assert.ok(prepare.keys[0].isSigner); assert.ok(prepare.keys[1].isSigner); assert.equal(prepare.keys[0].isWritable, false);
  const a = await derivePoolAddresses(programId, creator, 7n);
  assert.equal(prepare.keys[2].pubkey.toBase58(), a.pool.toBase58());
  const activate = await buildActivateLaunchInstruction(programId, creator, 7n);
  assert.equal(activate.keys[8].pubkey.toBase58(), (await programDataAddress(programId)).toBase58());
  assert.equal(activate.keys[9].pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.equal((await buildCancelPreparationInstruction(programId, creator, 7n)).keys.length, 2);
  for (const build of [buildBuyInstruction, buildSellInstruction]) {
    const ix = await build(programId, { creator, nonce: 7n, trader: creator, amountIn: 10000n, minimumOut: 1n, expirySlot: 900n });
    const args = new Reader(ix.data.subarray(8)); assert.equal(args.long(), 10000n); assert.equal(args.long(), 1n); assert.equal(args.long(), 900n);
    assert.equal(ix.keys.length, 9); assert.ok(ix.keys[0].isSigner); assert.ok(ix.keys[8].pubkey.equals(SystemProgram.programId));
  }
  const claim = await buildClaimFeesInstruction(programId, { creator, nonce: 7n, recipients: [{ address: creator, weightBps: 10000, paid: 0n }] }, 0);
  assert.equal(claim.keys.length, 3); assert.ok(claim.keys.every((key) => !key.isSigner)); assert.equal(claim.data[8], 0);
});
test("maximum preparation, activation and swap+ATA packets fit 1232 bytes independently", async (t) => {
  const recipients = Array.from({ length: 7 }, (_, i) => ({ address: new PublicKey(new Uint8Array(32).fill(i + 2)), weightBps: i === 6 ? 1432 : 1428 }));
  const prepare = await buildPrepareLaunchInstruction(programId, { ...base, feeBps: 100, name: "N".repeat(32), symbol: "S".repeat(10), uri: "https://example.com/" + "x".repeat(180), recipients });
  const activate = await buildActivateLaunchInstruction(programId, creator, 7n);
  const a = await derivePoolAddresses(programId, creator, 7n);
  const buy = await buildBuyInstruction(programId, { creator, nonce: 7n, trader: creator, amountIn: 10000n, minimumOut: 1n, expirySlot: 900n });
  const sizes = { prepare: await size(prepare), activate: await size(activate), buyWithAta: await size(await buildCreateAssociatedTokenInstruction(creator, a.mint, creator), buy) };
  for (const value of Object.values(sizes)) assert.ok(value <= MAX_TRANSACTION_BYTES);
  t.diagnostic(JSON.stringify(sizes));
});
test("invalid terms, aliases, UTF-8 bounds and zero slippage minimum reject locally", async () => {
  await assert.rejects(buildPrepareLaunchInstruction(programId, { ...base, name: "🪙".repeat(9) }));
  await assert.rejects(buildPrepareLaunchInstruction(programId, { ...base, name: " " }));
  await assert.rejects(buildPrepareLaunchInstruction(programId, { ...base, name: "a\u0085b" }));
  await assert.rejects(buildPrepareLaunchInstruction(programId, { ...base, feeBps: 100, recipients: [{ address: programId, weightBps: 10000 }] }));
  await assert.rejects(buildPrepareLaunchInstruction(programId, { ...base, feeBps: 100, recipients: [{ address: (await derivePoolAddresses(programId, creator, 7n)).reserve, weightBps: 10000 }] }));
  await assert.rejects(buildBuyInstruction(programId, { creator, nonce: 7n, trader: creator, amountIn: 10000n, minimumOut: 0n, expirySlot: 900n }));
});

test("v3 PDA seeds, account order and instruction bytes match the original ABI fixture exactly", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./abi-fixture.json", import.meta.url), "utf8"));
  const fixtureCreator = new PublicKey(fixture.creator);
  const a = await derivePoolAddresses(programId, fixtureCreator, 7n);
  assert.deepEqual(Object.fromEntries(Object.entries(a).map(([key, value]) => [key, value instanceof PublicKey ? value.toBase58() : value])), fixture.addresses);
  const trade = { creator: fixtureCreator, nonce: 7n, trader: fixtureCreator, amountIn: 1_000_000_000n, minimumOut: 10n, expirySlot: 1000n };
  const instructions = {
    prepareLaunch: await buildPrepareLaunchInstruction(programId, { ...base, creator: fixtureCreator }),
    activateLaunch: await buildActivateLaunchInstruction(programId, fixtureCreator, 7n),
    cancelPreparation: await buildCancelPreparationInstruction(programId, fixtureCreator, 7n),
    buyExactIn: await buildBuyInstruction(programId, trade),
    sellExactIn: await buildSellInstruction(programId, trade),
    claimFees: await buildClaimFeesInstruction(programId, { creator: fixtureCreator, nonce: 7n, recipients: [{ address: fixtureCreator, weightBps: 10000, paid: 0n }] }, 0),
  };
  for (const [name, ix] of Object.entries(instructions)) {
    assert.deepEqual({ dataHex: Buffer.from(ix.data).toString("hex"), keys: ix.keys.map((key) => ({ address: key.pubkey.toBase58(), signer: key.isSigner, writable: key.isWritable })) }, fixture.instructions[name], name);
  }
});
