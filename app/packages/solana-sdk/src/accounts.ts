import { Buffer } from "buffer";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { discriminator, Reader, rpcSafeNumber, u64, utf8 } from "./encoding.ts";
import { claimableFees, FIXED_SUPPLY, FEE_BPS, MAX_VIRTUAL_SOL, MIN_VIRTUAL_SOL, TOKEN_DECIMALS, validateCurve, type CurveState } from "./math.ts";
import { encodeBase58 } from "./transactions.ts";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const UPGRADEABLE_LOADER_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const POOL_ACCOUNT_SPACE = 802;
export const SOL_VAULT_SPACE = 49;
/** Pool layout: 8-byte discriminator, version, then the status byte (0 prepared, 1 active, 2 cancelled). */
export const POOL_STATUS_OFFSET = 9;
const POOL_STATUS_ACTIVE = 1;
/** The proxy accepts at most 16 keys per getMultipleAccounts; a snapshot uses 5 of them. */
export const MAX_SNAPSHOT_EXTRA_ACCOUNTS = 11;
export type PoolAddresses = {
  pool: PublicKey; mint: PublicKey; tokenVault: PublicKey; reserve: PublicKey;
  fees: PublicKey; mintAuthority: PublicKey; bump: number;
};
export async function derivePoolAddresses(programId: PublicKey, creator: PublicKey, nonce: bigint): Promise<PoolAddresses> {
  const [pool, bump] = await PublicKey.findProgramAddress([utf8.encode("pool"), creator.toBytes(), u64(nonce)], programId);
  const derive = async (seed: string) => (await PublicKey.findProgramAddress([utf8.encode(seed), pool.toBytes()], programId))[0];
  const [mint, tokenVault, reserve, fees, mintAuthority] = await Promise.all(["mint", "token", "reserve", "fees", "mint-authority"].map(derive));
  return { pool, bump, mint, tokenVault, reserve, fees, mintAuthority };
}
/** Custody accounts are seeded by the pool address alone, so they are known before the pool is read. */
export async function deriveCustodyAddresses(programId: PublicKey, pool: PublicKey): Promise<Pick<PoolAddresses, "mint" | "tokenVault" | "reserve" | "fees">> {
  const derive = async (seed: string) => (await PublicKey.findProgramAddress([utf8.encode(seed), pool.toBytes()], programId))[0];
  const [mint, tokenVault, reserve, fees] = await Promise.all(["mint", "token", "reserve", "fees"].map(derive));
  return { mint, tokenVault, reserve, fees };
}
export async function deriveAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
  return (await PublicKey.findProgramAddress([owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID))[0];
}
export type Recipient = { address: PublicKey; weightBps: number; paid: bigint };
export type PoolAccount = CurveState & {
  version: 1; status: "prepared" | "active" | "cancelled"; bump: number; nonce: bigint;
  creator: PublicKey; rentPayer: PublicKey; mint: PublicKey; recipients: Recipient[];
  feesEarned: bigint; sequence: bigint; name: string; symbol: string; uri: string; contentHash: Uint8Array;
};

/** Owner and canonical PDA validation are required, not optional decoder flags. */
export async function decodePoolAccount(address: PublicKey, info: AccountInfo<Uint8Array>, programId: PublicKey): Promise<PoolAccount> {
  if (!info.owner.equals(programId) || info.executable) throw new Error("Wrong pool owner");
  if (info.data.length > POOL_ACCOUNT_SPACE) throw new Error("Unsupported pool allocation size");
  const r = new Reader(info.data);
  if (!r.take(8).equals(discriminator("account", "Pool"))) throw new Error("Wrong pool discriminator");
  const version = r.byte(); const statusByte = r.byte(); const bump = r.byte();
  if (version !== 1 || statusByte > 2) throw new Error("Unsupported pool version or status");
  const nonce = r.long(); const creator = r.key(); const rentPayer = r.key(); const mint = r.key();
  const virtualSol = r.long(); const feeBps = r.short(); const recipientCount = r.byte();
  if (recipientCount > 7 || !FEE_BPS.some((fee) => fee === feeBps) || virtualSol < MIN_VIRTUAL_SOL || virtualSol > MAX_VIRTUAL_SOL) throw new Error("Invalid pool terms");
  const recipients: Recipient[] = [];
  for (let i = 0; i < 7; i++) {
    const recipient = { address: r.key(), weightBps: r.short(), paid: r.wide() };
    if (i < recipientCount) recipients.push(recipient);
    else if (!recipient.address.equals(PublicKey.default) || recipient.weightBps !== 0 || recipient.paid !== 0n) throw new Error("Nonempty unused recipient");
  }
  const tokenInventory = r.long(); const realSolReserves = r.long(); const feesEarned = r.wide(); const sequence = r.long();
  const name = r.text(32); const symbol = r.text(10); const uri = r.text(200, true); const contentHash = new Uint8Array(r.take(32)); r.finish();
  const addresses = await derivePoolAddresses(programId, creator, nonce);
  if (!address.equals(addresses.pool) || bump !== addresses.bump || !mint.equals(addresses.mint)) throw new Error("Noncanonical pool or mint");
  validateRecipients(recipients, feeBps, addresses, programId);
  for (const recipient of recipients) claimableFees(feesEarned, recipient.weightBps, recipient.paid);
  if (recipients.reduce((sum, x) => sum + x.paid, 0n) > feesEarned) throw new Error("Fee liabilities are invalid");
  const result: PoolAccount = {
    version, status: (["prepared", "active", "cancelled"] as const)[statusByte], bump, nonce, creator, rentPayer, mint,
    virtualSol, feeBps, recipients, tokenInventory, realSolReserves, feesEarned, sequence, name, symbol, uri, contentHash,
  };
  if (result.status === "active") validateCurve(result);
  else if (tokenInventory !== 0n || realSolReserves !== 0n || feesEarned !== 0n || sequence !== 0n) throw new Error("Inactive pool has live accounting");
  return result;
}
export function validateRecipients(recipients: ReadonlyArray<{ address: PublicKey; weightBps: number }>, feeBps: number, addresses?: PoolAddresses, programId?: PublicKey): void {
  if (!FEE_BPS.some((fee) => fee === feeBps)) throw new Error("Unsupported fee");
  if (feeBps === 0 ? recipients.length !== 0 : recipients.length < 1 || recipients.length > 7) throw new Error("Invalid recipient count");
  const seen = new Set<string>();
  const forbidden = addresses ? [addresses.pool, addresses.mint, addresses.tokenVault, addresses.reserve, addresses.fees, addresses.mintAuthority] : [];
  for (const r of recipients) {
    if (r.address.equals(PublicKey.default) || (programId && r.address.equals(programId)) || forbidden.some((x) => x.equals(r.address)) || seen.has(r.address.toBase58()) || !Number.isInteger(r.weightBps) || r.weightBps < 1 || r.weightBps > 10_000) throw new Error("Invalid or duplicate recipient");
    seen.add(r.address.toBase58());
  }
  if (feeBps !== 0 && recipients.reduce((sum, r) => sum + r.weightBps, 0) !== 10_000) throw new Error("Recipient weights must total 10000");
}
export async function programDataAddress(programId: PublicKey): Promise<PublicKey> {
  return (await PublicKey.findProgramAddress([programId.toBytes()], UPGRADEABLE_LOADER_ID))[0];
}
export async function decodeImmutableProgram(programId: PublicKey, executable: AccountInfo<Uint8Array>, dataAddress: PublicKey, data: AccountInfo<Uint8Array>): Promise<{ deploymentSlot: bigint }> {
  const executableBytes = Buffer.from(executable.data); const dataBytes = Buffer.from(data.data);
  if (!executable.executable || !executable.owner.equals(UPGRADEABLE_LOADER_ID) || executableBytes.length !== 36 || executableBytes.readUInt32LE(0) !== 2) throw new Error("Unsupported executable loader state");
  const recorded = new PublicKey(executable.data.subarray(4, 36));
  if (!recorded.equals(dataAddress) || !dataAddress.equals(await programDataAddress(programId))) throw new Error("ProgramData does not belong to this program");
  if (data.executable || !data.owner.equals(UPGRADEABLE_LOADER_ID) || dataBytes.length < 45 || dataBytes.readUInt32LE(0) !== 3) throw new Error("Invalid ProgramData");
  if (data.data[12] !== 0) throw new Error("Program still has an upgrade authority");
  return { deploymentSlot: dataBytes.readBigUInt64LE(4) };
}
export async function verifyImmutableProgram(connection: Connection, programId: PublicKey): Promise<{ programData: PublicKey; deploymentSlot: bigint; slot: number }> {
  const programData = await programDataAddress(programId);
  // Only the 45-byte ProgramData header is checked; never download the whole ELF on every load and review.
  const { context, value } = await connection.getMultipleAccountsInfoAndContext([programId, programData], { commitment: "finalized", dataSlice: { offset: 0, length: 45 } });
  if (!value[0] || !value[1]) throw new Error("Program is not deployed");
  return { programData, ...await decodeImmutableProgram(programId, value[0], programData, value[1]), slot: rpcSafeNumber(context.slot, "Program slot") };
}

function actualLamports(info: AccountInfo<Uint8Array>): bigint {
  if (typeof info.lamports !== "bigint" || info.lamports < 0n || info.lamports > (1n << 64n) - 1n) throw new Error("Invalid RPC lamport balance");
  return info.lamports;
}
function verifySolVault(info: AccountInfo<Uint8Array>, programId: PublicKey, pool: PublicKey, kind: number, liability: bigint): void {
  if (!info.owner.equals(programId) || info.executable || info.data.length !== SOL_VAULT_SPACE) throw new Error("Invalid SOL vault owner or size");
  const r = new Reader(info.data);
  if (!r.take(8).equals(discriminator("account", "SolVault")) || !r.key().equals(pool) || r.byte() !== kind) throw new Error("Invalid SOL vault linkage");
  const rentFloor = r.long();
  if (actualLamports(info) < rentFloor + liability) throw new Error("SOL vault is underfunded");
}
export type PoolSnapshot = { address: PublicKey; addresses: PoolAddresses; pool: PoolAccount; slot: number };
/** The address holds no valid pool (missing, another kind of account, or failed custody checks). Retrying will not help. */
export class PoolStateError extends Error {}
export async function fetchPoolSnapshot(connection: Connection, programId: PublicKey, address: PublicKey): Promise<PoolSnapshot> {
  return (await readPoolSnapshot(connection, programId, address)).snapshot;
}
/**
 * The pool, its custody and up to 11 caller accounts (a wallet and its token account, say) in one request, so one poll
 * is one RPC call and every account is read from the same bank. `extra` holds the caller accounts in order.
 */
export async function readPoolSnapshot(connection: Connection, programId: PublicKey, address: PublicKey, extra: readonly PublicKey[] = []): Promise<{ snapshot: PoolSnapshot; extra: (AccountInfo<Uint8Array> | null)[] }> {
  if (extra.length > MAX_SNAPSHOT_EXTRA_ACCOUNTS) throw new RangeError("Too many accounts for one snapshot read");
  const custody = await deriveCustodyAddresses(programId, address);
  // One bank/context for state and custody; never mix independent vault read slots.
  const { context, value } = await connection.getMultipleAccountsInfoAndContext([address, custody.mint, custody.tokenVault, custody.reserve, custody.fees, ...extra], { commitment: "confirmed" });
  // RPC failures above propagate as they are; everything below is about what the address holds.
  try {
    return { snapshot: await validatedSnapshot(programId, address, value, rpcSafeNumber(context.slot, "Snapshot slot")), extra: value.slice(5) };
  } catch (e) {
    throw e instanceof PoolStateError ? e : new PoolStateError(e instanceof Error ? e.message : "Invalid pool state");
  }
}
async function validatedSnapshot(programId: PublicKey, address: PublicKey, value: (AccountInfo<Uint8Array> | null)[], slot: number): Promise<PoolSnapshot> {
  if (!value[0]) throw new PoolStateError("Pool not found");
  if (value[0].data.length !== POOL_ACCOUNT_SPACE) throw new Error("Unexpected on-chain pool allocation");
  const pool = await decodePoolAccount(address, value[0], programId);
  // The decoder proved the address is this creator/nonce's canonical pool, so these match the custody read above.
  const addresses = await derivePoolAddresses(programId, pool.creator, pool.nonce);
  if (pool.status === "active") {
    const [, rawMint, rawToken, reserve, fees] = value;
    const mint = rawMint && { ...rawMint, data: Buffer.from(rawMint.data) };
    const token = rawToken && { ...rawToken, data: Buffer.from(rawToken.data) };
    if (!mint || !token || !reserve || !fees) throw new Error("Missing active custody accounts");
    if (!mint.owner.equals(TOKEN_PROGRAM_ID) || mint.executable || mint.data.length !== 82 || mint.data.readUInt32LE(0) !== 0 || mint.data[44] !== TOKEN_DECIMALS || mint.data[45] !== 1 || mint.data.readUInt32LE(46) !== 0 || mint.data.readBigUInt64LE(36) > FIXED_SUPPLY) throw new Error("Invalid mint authorities or supply");
    if (!token.owner.equals(TOKEN_PROGRAM_ID) || token.executable || token.data.length !== 165 || !new PublicKey(token.data.subarray(0, 32)).equals(addresses.mint) || !new PublicKey(token.data.subarray(32, 64)).equals(address) || token.data[108] !== 1 || token.data.readUInt32LE(72) !== 0 || token.data.readUInt32LE(109) !== 0 || token.data.readUInt32LE(129) !== 0 || token.data.readBigUInt64LE(64) < pool.tokenInventory) throw new Error("Invalid token vault custody");
    verifySolVault(reserve, programId, address, 0, pool.realSolReserves);
    verifySolVault(fees, programId, address, 1, pool.feesEarned - pool.recipients.reduce((sum, r) => sum + r.paid, 0n));
  }
  return { address, addresses, pool, slot };
}

/**
 * Active pools, with data read only for the rows returned. Prepared and cancelled pools are never closed, so the listing
 * filters on the status byte and asks for addresses alone: a few hundred bytes per active pool, however many tombstones
 * exist. Rows are in address order, which is stable but not a ranking; `total` counts every active pool.
 */
export async function fetchActivePools(connection: Connection, programId: PublicKey, limit = 50): Promise<{ total: number; pools: { address: PublicKey; pool: PoolAccount }[] }> {
  const rows = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { dataSize: POOL_ACCOUNT_SPACE },
      { memcmp: { offset: 0, bytes: encodeBase58(discriminator("account", "Pool")) } },
      { memcmp: { offset: POOL_STATUS_OFFSET, bytes: encodeBase58(Uint8Array.of(POOL_STATUS_ACTIVE)) } },
    ],
  });
  const keys = rows.map((row) => row.pubkey).sort((x, y) => (x.toBase58() < y.toBase58() ? -1 : 1)).slice(0, limit);
  const chunks: PublicKey[][] = [];
  for (let i = 0; i < keys.length; i += 16) chunks.push(keys.slice(i, i + 16));
  const infos = (await Promise.all(chunks.map((chunk) => connection.getMultipleAccountsInfo(chunk, "confirmed")))).flat();
  const pools = (await Promise.all(keys.map(async (address, i) => {
    const info = infos[i];
    if (!info) return [];
    try {
      const pool = await decodePoolAccount(address, info, programId);
      return pool.status === "active" ? [{ address, pool }] : [];
    } catch {
      return [];
    }
  }))).flat();
  return { total: rows.length, pools };
}
