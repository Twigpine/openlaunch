import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";
import { programDataAddress } from "./accounts.ts";

export type DeploymentManifest = {
  schema: 1; cluster: "mainnet-beta" | "devnet"; programId: string; programData: string;
  genesisHash: string; sourceCommit: string; binarySha256: string;
  verifiedSlot: number | null; securityReview: string | null; economicReview: string | null; releaseApproved: boolean;
};
export function validateDeploymentManifest(input: unknown): DeploymentManifest {
  if (!input || typeof input !== "object") throw new Error("Invalid manifest");
  const m = input as Record<string, unknown>;
  if (m.schema !== 1 || !["mainnet-beta", "devnet"].includes(String(m.cluster)) || typeof m.programId !== "string" || typeof m.programData !== "string" || typeof m.genesisHash !== "string" || typeof m.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(m.sourceCommit) || typeof m.binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.binarySha256)) throw new Error("Manifest needs exact program, cluster, genesis, source commit and binary hash");
  const program = new PublicKey(m.programId);
  if (program.equals(PublicKey.default) || program.toBase58() === "Fg6PaFpoGXkYsidMpWxTWqkZPknxNpEMTZfkhHQjBcqr") throw new Error("Test fixture is not a deployment identity");
  if (!programDataAddress(program).equals(new PublicKey(m.programData))) throw new Error("Manifest ProgramData mismatch");
  if (new PublicKey(m.genesisHash).toBase58() !== m.genesisHash) throw new Error("Invalid genesis hash");
  if (m.verifiedSlot !== null && (!Number.isSafeInteger(m.verifiedSlot) || Number(m.verifiedSlot) < 0)) throw new Error("Invalid verified slot");
  if (typeof m.releaseApproved !== "boolean" || (m.securityReview !== null && typeof m.securityReview !== "string") || (m.economicReview !== null && typeof m.economicReview !== "string")) throw new Error("Invalid review metadata");
  if (m.releaseApproved && (!m.securityReview || !m.economicReview || !m.verifiedSlot)) throw new Error("Release approval requires review evidence");
  return m as unknown as DeploymentManifest;
}
/** Hash the reviewed ELF, compare every deployed code byte, and reject nonzero trailing deployment padding. */
export function verifyDeploymentBytes(programData: Uint8Array, reviewedElf: Uint8Array, expectedSha256: string): string {
  if (reviewedElf.length < 64 || reviewedElf.length > 16 * 1024 * 1024 || !Buffer.from(reviewedElf.subarray(0, 4)).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error("Expected a bounded ELF binary");
  const hash = Buffer.from(sha256(reviewedElf)).toString("hex");
  if (hash !== expectedSha256) throw new Error("Reviewed binary SHA-256 does not match manifest");
  if (programData.length < 45 + reviewedElf.length || !Buffer.from(programData.subarray(45, 45 + reviewedElf.length)).equals(Buffer.from(reviewedElf)) || programData.subarray(45 + reviewedElf.length).some((byte) => byte !== 0)) throw new Error("Deployed program bytes differ from reviewed binary");
  return hash;
}
