import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "buffer";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { decodeImmutableProgram, decodePoolAccount, derivePoolAddresses, fetchActivePools, fetchPoolSnapshot, POOL_ACCOUNT_SPACE, PoolStateError, programDataAddress, readPoolSnapshot, TOKEN_PROGRAM_ID, UPGRADEABLE_LOADER_ID, verifyImmutableProgram } from "../src/accounts.ts";
import { encodeBase58 } from "../src/transactions.ts";
import { discriminator, textField, u8, u16, u64 } from "../src/encoding.ts";
import { FIXED_SUPPLY } from "../src/math.ts";

const programId = new PublicKey("Fg6PaFpoGXkYsidMpWxTWqkZPknxNpEMTZfkhHQjBcqr");
const creator = new PublicKey(new Uint8Array(32).fill(1));
const nonce = 7n;
const a = derivePoolAddresses(programId, creator, nonce);
function account(data: Buffer, owner = programId, lamports = 10000000): AccountInfo<Buffer> { return { data, owner, lamports, executable: false, rentEpoch: 0 }; }
function poolBytes(active = false): Buffer {
  return Buffer.concat([discriminator("account", "Pool"), u8(1), u8(active ? 1 : 0), u8(a.bump), u64(nonce), creator.toBuffer(), creator.toBuffer(), a.mint.toBuffer(), u64(30_000_000_000n), u16(0), u8(0), Buffer.alloc(7 * 50), u64(active ? FIXED_SUPPLY : 0n), u64(0n), Buffer.alloc(16), u64(0n), textField("Example", 32, "name"), textField("EX", 10, "symbol"), textField("", 200, "uri", true), Buffer.alloc(32)]);
}
test("Pool decoding preserves case-sensitive addresses, empty URI, exact reserves and PDA", () => {
  const pool = decodePoolAccount(a.pool, account(poolBytes()), programId);
  assert.equal(pool.status, "prepared"); assert.equal(pool.uri, ""); assert.equal(pool.nonce, 7n);
  assert.equal(pool.creator.toBase58(), creator.toBase58());
  assert.equal(decodePoolAccount(a.pool, account(poolBytes(true)), programId).tokenInventory, FIXED_SUPPLY);
  assert.throws(() => decodePoolAccount(creator, account(poolBytes()), programId), /Noncanonical/);
  assert.throws(() => decodePoolAccount(a.pool, account(poolBytes(), TOKEN_PROGRAM_ID), programId), /owner/);
  assert.throws(() => decodePoolAccount(a.pool, account(poolBytes().subarray(0, 40)), programId), /Truncated/);
  assert.throws(() => decodePoolAccount(a.pool, account(Buffer.concat([poolBytes(), Buffer.from([1])])), programId), /suffix/);
});
test("immutable check requires own linked ProgramData, expected loader and null authority", () => {
  const dataAddress = programDataAddress(programId);
  const exe = account(Buffer.concat([Buffer.from([2, 0, 0, 0]), dataAddress.toBuffer()]), UPGRADEABLE_LOADER_ID); exe.executable = true;
  const data = account(Buffer.concat([Buffer.from([3, 0, 0, 0]), u64(123n), Buffer.alloc(33), Buffer.alloc(100)]), UPGRADEABLE_LOADER_ID);
  assert.equal(decodeImmutableProgram(programId, exe, dataAddress, data).deploymentSlot, 123n);
  assert.throws(() => decodeImmutableProgram(programId, exe, a.pool, data), /belong/);
  data.data[12] = 1; assert.throws(() => decodeImmutableProgram(programId, exe, dataAddress, data), /upgrade authority/);
  data.data[12] = 0; data.owner = creator; assert.throws(() => decodeImmutableProgram(programId, exe, dataAddress, data), /ProgramData/);
});
function mintBytes(): Buffer {
  const b = Buffer.alloc(82); b.writeBigUInt64LE(FIXED_SUPPLY, 36); b[44] = 6; b[45] = 1; return b;
}
function tokenBytes(): Buffer {
  const b = Buffer.alloc(165); a.mint.toBuffer().copy(b, 0); a.pool.toBuffer().copy(b, 32); b.writeBigUInt64LE(FIXED_SUPPLY, 64); b[108] = 1; return b;
}
function vaultBytes(kind: number): Buffer { return Buffer.concat([discriminator("account", "SolVault"), a.pool.toBuffer(), u8(kind), u64(1000n)]); }
test("snapshot accepts donated surplus, rejects invalid custody and reads one context", async () => {
  const fullPool = Buffer.alloc(POOL_ACCOUNT_SPACE); poolBytes(true).copy(fullPool);
  const values = [account(fullPool), account(mintBytes(), TOKEN_PROGRAM_ID), account(tokenBytes(), TOKEN_PROGRAM_ID), account(vaultBytes(0)), account(vaultBytes(1))];
  let calls = 0;
  let requested: PublicKey[] = [];
  const fake = {
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => { calls++; requested = keys; return { context: { slot: 5 }, value: [...values, ...keys.slice(5).map(() => null)] }; },
  } as unknown as Connection;
  assert.equal((await fetchPoolSnapshot(fake, programId, a.pool)).slot, 5);
  // One request: custody comes from the pool address alone, so no first read of the pool is needed.
  assert.equal(calls, 1);
  assert.deepEqual(requested.map(String), [a.pool, a.mint, a.tokenVault, a.reserve, a.fees].map(String));
  const wallet = new PublicKey(new Uint8Array(32).fill(9));
  const read = await readPoolSnapshot(fake, programId, a.pool, [wallet]);
  assert.equal(requested.at(-1)?.toBase58(), wallet.toBase58()); assert.deepEqual(read.extra, [null]);
  await assert.rejects(readPoolSnapshot(fake, programId, a.pool, Array(12).fill(wallet)), /Too many/);
  values[2].data.writeUInt32LE(1, 72);
  await assert.rejects(fetchPoolSnapshot(fake, programId, a.pool), /custody/);
  values[2].data.writeUInt32LE(0, 72);
  values[3].lamports = 1;
  await assert.rejects(fetchPoolSnapshot(fake, programId, a.pool), /underfunded/);
  values[3].lamports = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(fetchPoolSnapshot(fake, programId, a.pool), /precision/);
});
test("the pool list filters active pools on-chain and reads data only for the rows it shows", async () => {
  const fullPool = Buffer.alloc(POOL_ACCOUNT_SPACE); poolBytes(true).copy(fullPool);
  const keys = Array.from({ length: 40 }, (_, i) => new PublicKey(new Uint8Array(32).fill(i + 10)));
  let config: { dataSlice?: unknown; filters?: unknown[] } = {};
  const batches: number[] = [];
  const fake = {
    getProgramAccounts: async (_program: PublicKey, given: typeof config) => { config = given; return keys.map((pubkey) => ({ pubkey, account: account(Buffer.alloc(0)) })); },
    // Only the canonical pool decodes; the other addresses stand in for rows that fail validation.
    getMultipleAccountsInfo: async (chunk: PublicKey[]) => { batches.push(chunk.length); return chunk.map((key) => (key.equals(a.pool) ? account(fullPool) : null)); },
  } as unknown as Connection;
  keys[0] = a.pool;
  const result = await fetchActivePools(fake, programId, 34);
  assert.deepEqual(config.dataSlice, { offset: 0, length: 0 });
  assert.deepEqual(config.filters, [
    { dataSize: POOL_ACCOUNT_SPACE },
    { memcmp: { offset: 0, bytes: encodeBase58(discriminator("account", "Pool")) } },
    { memcmp: { offset: 9, bytes: "2" } },
  ]);
  assert.equal(result.total, 40);
  assert.deepEqual(batches, [16, 16, 2]);
  assert.deepEqual(result.pools.map((p) => p.address.toBase58()), [a.pool.toBase58()]);
});
test("the immutability check downloads only the ProgramData header", async () => {
  let given: { dataSlice?: unknown } = {};
  const fake = { getMultipleAccountsInfoAndContext: async (_keys: PublicKey[], config: typeof given) => { given = config; return { context: { slot: 1 }, value: [null, null] }; } } as unknown as Connection;
  await assert.rejects(verifyImmutableProgram(fake, programId), /not deployed/);
  assert.deepEqual(given.dataSlice, { offset: 0, length: 45 });
});
test("an address holding no valid pool is a PoolStateError; RPC failures are not", async () => {
  const missing = { getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({ context: { slot: 1 }, value: keys.map(() => null) }) } as unknown as Connection;
  await assert.rejects(fetchPoolSnapshot(missing, programId, a.pool), (e: unknown) => e instanceof PoolStateError && /not found/.test(e.message));
  const other = { getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({ context: { slot: 1 }, value: keys.map((_, i) => (i === 0 ? account(Buffer.alloc(40), TOKEN_PROGRAM_ID) : null)) }) } as unknown as Connection;
  await assert.rejects(fetchPoolSnapshot(other, programId, a.pool), PoolStateError);
  const down = { getMultipleAccountsInfoAndContext: async () => { throw new Error("503 Service Unavailable"); } } as unknown as Connection;
  await assert.rejects(fetchPoolSnapshot(down, programId, a.pool), (e: unknown) => !(e instanceof PoolStateError));
});
