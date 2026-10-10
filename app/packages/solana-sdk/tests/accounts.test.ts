import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "buffer";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { decodeImmutableProgram, decodePoolAccount, derivePoolAddresses, fetchPoolSnapshot, POOL_ACCOUNT_SPACE, programDataAddress, TOKEN_PROGRAM_ID, UPGRADEABLE_LOADER_ID } from "../src/accounts.ts";
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
  const fake = {
    getAccountInfo: async () => values[0],
    getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 5 }, value: values }),
  } as unknown as Connection;
  assert.equal((await fetchPoolSnapshot(fake, programId, a.pool)).slot, 5);
  values[2].data.writeUInt32LE(1, 72);
  await assert.rejects(fetchPoolSnapshot(fake, programId, a.pool), /custody/);
  values[2].data.writeUInt32LE(0, 72);
  values[3].lamports = 1;
  await assert.rejects(fetchPoolSnapshot(fake, programId, a.pool), /underfunded/);
  values[3].lamports = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(fetchPoolSnapshot(fake, programId, a.pool), /precision/);
});
