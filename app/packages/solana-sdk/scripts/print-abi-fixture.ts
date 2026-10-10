/** Emits public deterministic fixture JSON; never creates keys or transactions on a network. */
import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { derivePoolAddresses } from "../src/accounts.ts";
import { discriminator, textField, u8, u16, u64 } from "../src/encoding.ts";
import { buildActivateLaunchInstruction, buildBuyInstruction, buildCancelPreparationInstruction, buildClaimFeesInstruction, buildPrepareLaunchInstruction, buildSellInstruction } from "../src/instructions.ts";

const programId = new PublicKey("Fg6PaFpoGXkYsidMpWxTWqkZPknxNpEMTZfkhHQjBcqr");
const creator = new PublicKey(new Uint8Array(32).fill(1));
const nonce = 7n;
const a = derivePoolAddresses(programId, creator, nonce);
const prepare = { creator, nonce, virtualSol: 30_000_000_000n, feeBps: 0, name: "Example", symbol: "EX", uri: "", contentHash: new Uint8Array(32), recipients: [] };
const trade = { creator, nonce, trader: creator, amountIn: 1_000_000_000n, minimumOut: 10n, expirySlot: 1000n };
const pool = Buffer.concat([discriminator("account", "Pool"), u8(1), u8(0), u8(a.bump), u64(nonce), creator.toBuffer(), creator.toBuffer(), a.mint.toBuffer(), u64(prepare.virtualSol), u16(0), u8(0), Buffer.alloc(7 * 50), u64(0n), u64(0n), Buffer.alloc(16), u64(0n), textField("Example", 32, "name"), textField("EX", 10, "symbol"), textField("", 200, "uri", true), Buffer.alloc(32)]);
const instructions = {
  prepareLaunch: buildPrepareLaunchInstruction(programId, prepare),
  activateLaunch: buildActivateLaunchInstruction(programId, creator, nonce),
  cancelPreparation: buildCancelPreparationInstruction(programId, creator, nonce),
  buyExactIn: buildBuyInstruction(programId, trade),
  sellExactIn: buildSellInstruction(programId, trade),
  claimFees: buildClaimFeesInstruction(programId, { creator, nonce, recipients: [{ address: creator, weightBps: 10000, paid: 0n }] }, 0),
};
console.log(JSON.stringify({
  note: "Undeployed fixture identity only; no private key or network activity.",
  programId: programId.toBase58(), creator: creator.toBase58(), nonce: nonce.toString(),
  addresses: Object.fromEntries(Object.entries(a).map(([key, value]) => [key, typeof value === "number" ? value : value.toBase58()])),
  preparedPoolHex: pool.toString("hex"),
  instructions: Object.fromEntries(Object.entries(instructions).map(([key, ix]) => [key, { dataHex: ix.data.toString("hex"), keys: ix.keys.map((k) => ({ address: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })) }])),
}, null, 2));
