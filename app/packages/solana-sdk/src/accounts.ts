import { Buffer } from "buffer";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { discriminator, Reader, u64, utf8 } from "./encoding.ts";
import { claimableFees, FIXED_SUPPLY, FEE_BPS, MAX_VIRTUAL_SOL, MIN_VIRTUAL_SOL, TOKEN_DECIMALS, validateCurve, type CurveState } from "./math.ts";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const UPGRADEABLE_LOADER_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const POOL_ACCOUNT_SPACE = 802;
export const SOL_VAULT_SPACE = 49;
export type PoolAddresses = {
  pool: PublicKey; mint: PublicKey; tokenVault: PublicKey; reserve: PublicKey;
  fees: PublicKey; mintAuthority: PublicKey; bump: number;
};
export function derivePoolAddresses(programId: PublicKey, creator: PublicKey, nonce: bigint): PoolAddresses {
  const [pool, bump] = PublicKey.findProgramAddressSync([utf8.encode("pool"), creator.toBytes(), u64(nonce)], programId);
  const derive = (seed: string) => PublicKey.findProgramAddressSync([utf8.encode(seed), pool.toBytes()], programId)[0];
  return { pool, bump, mint: derive("mint"), tokenVault: derive("token"), reserve: derive("reserve"), fees: derive("fees"), mintAuthority: derive("mint-authority") };
}
export function deriveAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}
export type Recipient = { address: PublicKey; weightBps: number; paid: bigint };
export type PoolAccount = CurveState & {
  version: 1; status: "prepared" | "active" | "cancelled"; bump: number; nonce: bigint;
  creator: PublicKey; rentPayer: PublicKey; mint: PublicKey; recipients: Recipient[];
  feesEarned: bigint; sequence: bigint; name: string; symbol: string; uri: string; contentHash: Uint8Array;
};

/** Owner and canonical PDA validation are required, not optional decoder flags. */
export function decodePoolAccount(address: PublicKey, info: AccountInfo<Buffer>, programId: PublicKey): PoolAccount {
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
  const addresses = derivePoolAddresses(programId, creator, nonce);
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
export function programDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBytes()], UPGRADEABLE_LOADER_ID)[0];
}
export function decodeImmutableProgram(programId: PublicKey, executable: AccountInfo<Buffer>, dataAddress: PublicKey, data: AccountInfo<Buffer>): { deploymentSlot: bigint } {
  if (!executable.executable || !executable.owner.equals(UPGRADEABLE_LOADER_ID) || executable.data.length !== 36 || executable.data.readUInt32LE(0) !== 2) throw new Error("Unsupported executable loader state");
  const recorded = new PublicKey(executable.data.subarray(4, 36));
  if (!recorded.equals(dataAddress) || !dataAddress.equals(programDataAddress(programId))) throw new Error("ProgramData does not belong to this program");
  if (data.executable || !data.owner.equals(UPGRADEABLE_LOADER_ID) || data.data.length < 45 || data.data.readUInt32LE(0) !== 3) throw new Error("Invalid ProgramData");
  if (data.data[12] !== 0) throw new Error("Program still has an upgrade authority");
  return { deploymentSlot: data.data.readBigUInt64LE(4) };
}
export async function verifyImmutableProgram(connection: Connection, programId: PublicKey): Promise<{ programData: PublicKey; deploymentSlot: bigint; slot: number }> {
  const programData = programDataAddress(programId);
  const { context, value } = await connection.getMultipleAccountsInfoAndContext([programId, programData], { commitment: "finalized" });
  if (!value[0] || !value[1]) throw new Error("Program is not deployed");
  return { programData, ...decodeImmutableProgram(programId, value[0], programData, value[1]), slot: context.slot };
}

function actualLamports(info: AccountInfo<Buffer>): bigint {
  // web3.js v1 exposes RPC lamports as number: refuse unsafe rounding instead of inventing precision.
  if (!Number.isSafeInteger(info.lamports) || info.lamports < 0) throw new Error("RPC lamport balance exceeds safe integer precision");
  return BigInt(info.lamports);
}
function verifySolVault(info: AccountInfo<Buffer>, programId: PublicKey, pool: PublicKey, kind: number, liability: bigint): void {
  if (!info.owner.equals(programId) || info.executable || info.data.length !== SOL_VAULT_SPACE) throw new Error("Invalid SOL vault owner or size");
  const r = new Reader(info.data);
  if (!r.take(8).equals(discriminator("account", "SolVault")) || !r.key().equals(pool) || r.byte() !== kind) throw new Error("Invalid SOL vault linkage");
  const rentFloor = r.long();
  if (actualLamports(info) < rentFloor + liability) throw new Error("SOL vault is underfunded");
}
export type PoolSnapshot = { address: PublicKey; addresses: PoolAddresses; pool: PoolAccount; slot: number };
export async function fetchPoolSnapshot(connection: Connection, programId: PublicKey, address: PublicKey): Promise<PoolSnapshot> {
  const first = await connection.getAccountInfo(address, "confirmed");
  if (!first) throw new Error("Pool not found");
  if (first.data.length !== POOL_ACCOUNT_SPACE) throw new Error("Unexpected on-chain pool allocation");
  const initial = decodePoolAccount(address, first, programId);
  const addresses = derivePoolAddresses(programId, initial.creator, initial.nonce);
  // One bank/context for state and custody; never mix independent vault read slots.
  const { context, value } = await connection.getMultipleAccountsInfoAndContext([address, addresses.mint, addresses.tokenVault, addresses.reserve, addresses.fees], { commitment: "confirmed" });
  if (!value[0]) throw new Error("Pool not found");
  if (value[0].data.length !== POOL_ACCOUNT_SPACE) throw new Error("Unexpected on-chain pool allocation");
  const pool = decodePoolAccount(address, value[0], programId);
  if (pool.status === "active") {
    const [, mint, token, reserve, fees] = value;
    if (!mint || !token || !reserve || !fees) throw new Error("Missing active custody accounts");
    if (!mint.owner.equals(TOKEN_PROGRAM_ID) || mint.executable || mint.data.length !== 82 || mint.data.readUInt32LE(0) !== 0 || mint.data[44] !== TOKEN_DECIMALS || mint.data[45] !== 1 || mint.data.readUInt32LE(46) !== 0 || mint.data.readBigUInt64LE(36) > FIXED_SUPPLY) throw new Error("Invalid mint authorities or supply");
    if (!token.owner.equals(TOKEN_PROGRAM_ID) || token.executable || token.data.length !== 165 || !new PublicKey(token.data.subarray(0, 32)).equals(addresses.mint) || !new PublicKey(token.data.subarray(32, 64)).equals(address) || token.data[108] !== 1 || token.data.readUInt32LE(72) !== 0 || token.data.readUInt32LE(109) !== 0 || token.data.readUInt32LE(129) !== 0 || token.data.readBigUInt64LE(64) < pool.tokenInventory) throw new Error("Invalid token vault custody");
    verifySolVault(reserve, programId, address, 0, pool.realSolReserves);
    verifySolVault(fees, programId, address, 1, pool.feesEarned - pool.recipients.reduce((sum, r) => sum + r.paid, 0n));
  }
  return { address, addresses, pool, slot: context.slot };
}
