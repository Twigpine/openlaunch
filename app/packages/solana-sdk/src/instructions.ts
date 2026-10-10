import { Buffer } from "buffer";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, deriveAssociatedTokenAddress, derivePoolAddresses, programDataAddress, TOKEN_PROGRAM_ID, validateRecipients, type PoolAccount } from "./accounts.ts";
import { discriminator, textField, u8, u16, u32, u64 } from "./encoding.ts";
import { bounded, MAX_VIRTUAL_SOL, MIN_VIRTUAL_SOL, U64_MAX } from "./math.ts";

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });
const instruction = (programId: PublicKey, name: string, keys: AccountMeta[], args: Buffer[] = []) =>
  new TransactionInstruction({ programId, keys, data: Buffer.concat([discriminator("global", name), ...args]) });
export type PrepareLaunchArgs = {
  creator: PublicKey; payer?: PublicKey; nonce: bigint; virtualSol: bigint; feeBps: number;
  name: string; symbol: string; uri: string; contentHash: Uint8Array;
  recipients: ReadonlyArray<{ address: PublicKey; weightBps: number }>;
};
export function buildPrepareLaunchInstruction(programId: PublicKey, args: PrepareLaunchArgs): TransactionInstruction {
  const addresses = derivePoolAddresses(programId, args.creator, args.nonce);
  validateRecipients(args.recipients, args.feeBps, addresses, programId);
  bounded(args.virtualSol, MAX_VIRTUAL_SOL, "Virtual SOL");
  if (args.virtualSol < MIN_VIRTUAL_SOL || args.contentHash.length !== 32) throw new Error("Invalid valuation or content hash");
  return instruction(programId, "prepare_launch", [meta(args.creator, false, true), meta(args.payer ?? args.creator, true, true), meta(addresses.pool, true), meta(SystemProgram.programId)], [
    u64(args.nonce), u64(args.virtualSol), u16(args.feeBps), textField(args.name, 32, "name"), textField(args.symbol, 10, "symbol"), textField(args.uri, 200, "URI", true), Buffer.from(args.contentHash),
    u32(args.recipients.length), ...args.recipients.flatMap((r) => [r.address.toBuffer(), u16(r.weightBps)]),
  ]);
}
export function buildActivateLaunchInstruction(programId: PublicKey, creator: PublicKey, nonce: bigint): TransactionInstruction {
  const a = derivePoolAddresses(programId, creator, nonce);
  return instruction(programId, "activate_launch", [meta(creator, true, true), meta(a.pool, true), meta(a.mint, true), meta(a.tokenVault, true), meta(a.reserve, true), meta(a.fees, true), meta(a.mintAuthority), meta(programId), meta(programDataAddress(programId)), meta(TOKEN_PROGRAM_ID), meta(SystemProgram.programId), meta(SYSVAR_RENT_PUBKEY)]);
}
export function buildCancelPreparationInstruction(programId: PublicKey, creator: PublicKey, nonce: bigint): TransactionInstruction {
  return instruction(programId, "cancel_preparation", [meta(creator, false, true), meta(derivePoolAddresses(programId, creator, nonce).pool, true)]);
}
export type TradeInstructionArgs = {
  creator: PublicKey; nonce: bigint; trader: PublicKey; traderToken?: PublicKey;
  amountIn: bigint; minimumOut: bigint; expirySlot: bigint;
};
function tradeInstruction(programId: PublicKey, name: string, args: TradeInstructionArgs): TransactionInstruction {
  const a = derivePoolAddresses(programId, args.creator, args.nonce);
  bounded(args.amountIn, U64_MAX, "Amount in"); bounded(args.minimumOut, U64_MAX, "Minimum out");
  if (args.amountIn === 0n || args.minimumOut === 0n) throw new Error("Input and slippage minimum must be positive");
  const traderToken = args.traderToken ?? deriveAssociatedTokenAddress(a.mint, args.trader);
  return instruction(programId, name, [meta(args.trader, true, true), meta(a.pool, true), meta(a.mint), meta(a.tokenVault, true), meta(a.reserve, true), meta(a.fees, true), meta(traderToken, true), meta(TOKEN_PROGRAM_ID), meta(SystemProgram.programId)], [u64(args.amountIn), u64(args.minimumOut), u64(args.expirySlot)]);
}
export const buildBuyInstruction = (programId: PublicKey, args: TradeInstructionArgs): TransactionInstruction => tradeInstruction(programId, "buy_exact_in", args);
export const buildSellInstruction = (programId: PublicKey, args: TradeInstructionArgs): TransactionInstruction => tradeInstruction(programId, "sell_exact_in", args);
export function buildClaimFeesInstruction(programId: PublicKey, pool: Pick<PoolAccount, "creator" | "nonce" | "recipients">, recipientIndex: number): TransactionInstruction {
  if (!Number.isInteger(recipientIndex) || recipientIndex < 0 || recipientIndex >= pool.recipients.length) throw new Error("Invalid recipient index");
  const a = derivePoolAddresses(programId, pool.creator, pool.nonce);
  return instruction(programId, "claim_fees", [meta(a.pool, true), meta(a.fees, true), meta(pool.recipients[recipientIndex].address, true)], [u8(recipientIndex)]);
}
/** Idempotent official ATA creation. Rent/fees are extra; this never wraps SOL. */
export function buildCreateAssociatedTokenInstruction(payer: PublicKey, mint: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [meta(payer, true, true), meta(deriveAssociatedTokenAddress(mint, owner), true), meta(owner), meta(mint), meta(SystemProgram.programId), meta(TOKEN_PROGRAM_ID)], data: Buffer.from([1]) });
}
