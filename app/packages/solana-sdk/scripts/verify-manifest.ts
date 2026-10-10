/** Read-only release evidence. No wallet, private-key input, transaction, deployment or authority operation. */
import { readFile } from "node:fs/promises";
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeImmutableProgram, programDataAddress, TOKEN_PROGRAM_ID } from "../src/accounts.ts";
import { validateDeploymentManifest, verifyDeploymentBytes } from "../src/verification.ts";

let stage = "read manifest and reviewed ELF";
try {
  const [manifestPath, elfPath, ...extra] = process.argv.slice(2);
  if (!manifestPath || !elfPath || extra.length > 0) throw new Error("usage");
  const manifest = validateDeploymentManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const elf = await readFile(elfPath);
  stage = "connect to the explicitly configured read-only RPC";
  const rpcUrl = process.env.SOLANA_VERIFY_RPC_URL;
  if (!rpcUrl) throw new Error("Missing RPC configuration");
  const url = new URL(rpcUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("HTTPS required");
  const connection = new Connection(rpcUrl, { commitment: "finalized", disableRetryOnRateLimit: true, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }) });
  stage = "match the RPC genesis hash to the reviewed manifest";
  if (await connection.getGenesisHash() !== manifest.genesisHash) throw new Error("Wrong cluster");
  stage = "read finalized program and dependency accounts";
  const programId = new PublicKey(manifest.programId);
  const ownData = new PublicKey(manifest.programData);
  const tokenData = programDataAddress(TOKEN_PROGRAM_ID);
  const { context, value } = await connection.getMultipleAccountsInfoAndContext([programId, ownData, TOKEN_PROGRAM_ID, tokenData], { commitment: "finalized" });
  const [program, programData, tokenProgram, tokenProgramData] = value;
  if (!program || !programData || !tokenProgram || !tokenProgramData) throw new Error("Missing program accounts");
  stage = "verify linked immutable launch and legacy Token programs";
  const own = decodeImmutableProgram(programId, program, ownData, programData);
  const token = decodeImmutableProgram(TOKEN_PROGRAM_ID, tokenProgram, tokenData, tokenProgramData);
  stage = "compare deployed program bytes with the reviewed local ELF";
  const hash = verifyDeploymentBytes(programData.data, elf, manifest.binarySha256);
  console.log(JSON.stringify({
    schema: 1, evidence: "read-only-rpc-and-binary-check", observedAt: new Date().toISOString(),
    cluster: manifest.cluster, genesisHash: manifest.genesisHash, programId: manifest.programId,
    programData: manifest.programData, sourceCommit: manifest.sourceCommit, binarySha256: hash,
    verifiedSlot: context.slot, deploymentSlot: own.deploymentSlot.toString(), upgradeAuthority: null,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), tokenProgramData: tokenData.toBase58(), tokenDeploymentSlot: token.deploymentSlot.toString(), tokenUpgradeAuthority: null,
    releaseApproved: false,
    limitation: "This evidence is not an audit, source-to-binary reproducibility proof, or release approval. Independently verify using another trusted RPC and retain the build attestation.",
  }, null, 2));
} catch {
  // RPC URLs can contain API secrets. Never print third-party errors, stacks, input paths or environment values.
  console.error(`Verification failed at: ${stage}. No network state was changed. Check configuration and rerun. Usage: tsx packages/solana-sdk/scripts/verify-manifest.ts <manifest.json> <reviewed-program.so>; set SOLANA_VERIFY_RPC_URL privately.`);
  process.exitCode = 1;
}
