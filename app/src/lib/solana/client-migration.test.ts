import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { validateSignedTransaction } from "@openlaunch/solana-sdk";
import { journalKey, persistJournalForSession, readJournal, type PendingSolanaAction } from "./journal.ts";
import { validWalletAccount } from "./wallet.ts";

test("v3 wallet validation preserves account bytes and the existing JSON recovery record", async () => {
  // Disposable local fixture, never connected to an RPC or funded wallet.
  const payer = await Keypair.generate();
  const account = {
    address: payer.publicKey.toBase58(), publicKey: payer.publicKey.toBytes(),
    chains: ["solana:devnet" as const], features: ["solana:signTransaction" as const],
  };
  assert.equal(validWalletAccount(account, "solana:devnet"), true);
  assert.equal(validWalletAccount(account, "solana:mainnet"), false);
  assert.equal(validWalletAccount({ ...account, publicKey: new Uint8Array(32) }, "solana:devnet"), false);

  const transaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: new PublicKey(new Uint8Array(32).fill(3)).toBase58(),
  }).add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(new Uint8Array(32).fill(4)), lamports: 1n }));
  await transaction.sign(payer);
  // Produce fixture wire bytes; production validation below checks every signature strictly.
  const wire = await transaction.serialize({ verifySignatures: false });
  const verifying = validateSignedTransaction(transaction.serializeMessage(), wire, payer.publicKey);
  let current = true;
  current = false; // A wallet event arrives while the asynchronous verifier is running.
  const signed = await verifying;
  const record: PendingSolanaAction = {
    version: 1, programId: new PublicKey(new Uint8Array(32).fill(5)).toBase58(),
    cluster: "devnet", wallet: account.address, signature: signed.signature,
    lastValidBlockHeight: 100, label: "Buy tokens", pool: null,
  };
  const key = journalKey(record.programId, record.cluster, record.wallet);
  let raw: string | null = null;
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  assert.throws(() => persistJournalForSession(storage, key, record, () => current), /Wallet changed/);
  assert.equal(raw, null, "a session changed during crypto must never reach the durable send boundary");
  current = true;
  persistJournalForSession(storage, key, record, () => current);
  assert.deepEqual(readJournal(raw, record.programId, record.cluster, record.wallet), record);
  assert.equal(JSON.parse(raw!).lastValidBlockHeight, 100, "existing v1 numeric journal schema is unchanged");
});

test("the signing hook awaits verification then rechecks the session before persistence and send", () => {
  const hook = readFileSync(new URL("./useSolanaAction.ts", import.meta.url), "utf8");
  const verification = hook.indexOf("const signed = await validateSignedTransaction(");
  const sessionGuard = hook.indexOf("if (!reviewLive())", verification);
  const persistence = hook.indexOf("persistJournalForSession(localStorage, key, record, reviewLive)", sessionGuard);
  const submission = hook.indexOf("await submitSignedTransaction(connection, signed)", persistence);
  assert.ok(verification >= 0 && sessionGuard > verification && persistence > sessionGuard && submission > persistence);
  assert.doesNotMatch(hook.slice(sessionGuard, submission).replace(/\/\/[^\n]*/g, ""), /\bawait\b/);
});
