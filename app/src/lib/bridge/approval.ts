import { decodeEventLog, encodeFunctionData, isAddress, type Address, type Hex } from "viem";
import { bridgeCurrency, bridgeTokenAsset, isBridgeChainId, type BridgeChainId } from "./types";
import { CCTP_TOKEN_MESSENGER } from "./cctp";

// Independently pinned: provider calldata never chooses the token or spender.
// https://docs.arc.io/arc/references/contract-addresses
// https://docs.relay.link/references/protocol/contracts/evm-depository
export const ARC_APPROVAL_CHAIN_ID = 5042 as const;
export const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;
export const RELAY_APPROVAL_SPENDER = "0x4cd00e387622c35bddb9b4c962c136462338bc31" as const;
// Circle's TokenMessengerV2 (lib/bridge/cctp.ts), which pulls the exact amount it burns.
export const CCTP_APPROVAL_SPENDER = CCTP_TOKEN_MESSENGER.toLowerCase() as Address;
/** The only contracts an approval may name. Anything else is refused before the wallet is asked. */
export const APPROVAL_SPENDERS: readonly Address[] = [RELAY_APPROVAL_SPENDER, CCTP_APPROVAL_SPENDER];
const spenderOf = (value: unknown): Address | null => typeof value === "string" ? APPROVAL_SPENDERS.find((spender) => spender === value.toLowerCase()) ?? null : null;
export const EXACT_APPROVAL_ABI = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }] as const;
export const USDC_APPROVAL_EVENT = [{ type: "event", name: "Approval", inputs: [{ name: "owner", type: "address", indexed: true }, { name: "spender", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] }] as const;
export const APPROVAL_STORAGE_PREFIX = "openlaunch.bridge.approval.v1:";
const MAX_UINT = (1n << 256n) - 1n;
// The corresponding native balance uses 18 decimals; never overflow that value.
const MAX_APPROVAL_AMOUNT = MAX_UINT / 10n ** 12n;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const STATUSES = ["uncertain", "pending", "confirmed", "reverted", "insufficient"] as const;

// Omitted chain is legacy Arc; omitted spender is Relay's depository (every record before Circle). Amounts are token units, 6 decimals.
export type ApprovalRequest = { address: Address; amount: string; chainId?: BridgeChainId; spender?: Address };
export type ApprovalStatus = typeof STATUSES[number];
export type TrackedApproval = ApprovalRequest & {
  version: 1;
  chainId: BridgeChainId;
  token: Address;
  spender: Address;
  createdAt: number;
  status: ApprovalStatus;
  approvalHash?: Hex;
};
export type ApprovalTransaction = { chainId: BridgeChainId; to: Address; data: Hex; value: 0n };
export type ApprovalGas = { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

function validHash(value: unknown): value is Hex {
  return typeof value === "string" && HASH.test(value) && !/^0x0{64}$/i.test(value);
}

function validAmount(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) < MAX_UINT;
}

export function approvalToken(chainId: BridgeChainId = ARC_APPROVAL_CHAIN_ID): Address {
  // the chain's one ERC-20 (types.ts): USDC on Base and Arc, USDG on Robinhood Chain
  const asset = isBridgeChainId(chainId) ? bridgeTokenAsset(chainId) : null;
  if (!asset) throw new Error("Token approvals are not supported on this network.");
  return bridgeCurrency(chainId, asset, "input").address;
}

function validateRequest(value: ApprovalRequest): ApprovalRequest {
  if (!value || typeof value.address !== "string" || !isAddress(value.address, { strict: false }) || /^0x0{40}$/i.test(value.address) || !validAmount(value.amount)) {
    throw new Error("The token approval does not match a valid wallet and exact amount.");
  }
  const chainId = value.chainId ?? ARC_APPROVAL_CHAIN_ID;
  approvalToken(chainId);
  if (chainId === ARC_APPROVAL_CHAIN_ID && BigInt(value.amount) > MAX_APPROVAL_AMOUNT) throw new Error("The USDC approval amount exceeds Arc's native balance range.");
  const spender = value.spender === undefined ? RELAY_APPROVAL_SPENDER : spenderOf(value.spender);
  if (!spender) throw new Error("The token approval names an unsupported spender.");
  return { address: value.address, amount: value.amount, ...(value.chainId !== undefined ? { chainId } : {}), ...(spender !== RELAY_APPROVAL_SPENDER ? { spender } : {}) };
}

/** Validate provider metadata before adapting a quote to this fixed approval flow. */
export function validateApprovalMetadata(value: unknown, address: Address, chainId?: BridgeChainId): ApprovalRequest {
  const metadata = value as { token?: unknown; spender?: unknown; amount?: unknown } | null;
  if (!metadata || typeof metadata.token !== "string" || metadata.token.toLowerCase() !== approvalToken(chainId).toLowerCase() || !spenderOf(metadata.spender) || !validAmount(metadata.amount)) {
    throw new Error("The bridge requested an unsupported token, spender, or approval amount.");
  }
  return validateRequest({ address, amount: metadata.amount, ...(chainId !== undefined ? { chainId } : {}), spender: spenderOf(metadata.spender)! });
}

export function approvalRequestKey(request: ApprovalRequest | null): string {
  const spender = request?.spender?.toLowerCase();
  return request ? `${request.address.toLowerCase()}:${request.chainId ?? ARC_APPROVAL_CHAIN_ID}:${request.amount}${spender && spender !== RELAY_APPROVAL_SPENDER ? `:${spender}` : ""}` : "";
}

export const approvalStorageKey = (address: Address) => `${APPROVAL_STORAGE_PREFIX}${address.toLowerCase()}`;

export const APPROVAL_DISCARD_AFTER_MS = 15 * 60_000;
export type ApprovalReceiptObservation = { createdAt: number; receiptFound: boolean; observedAt: number };

/**
 * An approval that is still unmined after a long wait can be dropped: if it
 * mines later it only grants the exact allowance to the pinned depository, and
 * every deposit re-reads the allowance before asking the wallet. A record with
 * a hash needs a fresh "no receipt" observation; one without a hash cannot be
 * checked on-chain, so only the wait applies.
 */
export function approvalCanDiscard(approval: TrackedApproval | null, observation: ApprovalReceiptObservation | null, now: number): boolean {
  if (!approvalBlocksSubmission(approval) || now - approval!.createdAt < APPROVAL_DISCARD_AFTER_MS) return false;
  if (!approval!.approvalHash) return true;
  return !!observation && observation.createdAt === approval!.createdAt && !observation.receiptFound && now - observation.observedAt <= 60_000 && now >= observation.observedAt;
}

export function approvalBlocksSubmission(approval: TrackedApproval | null): boolean {
  return !!approval && (approval.status === "uncertain" || approval.status === "pending");
}

/** A delayed poll must not overwrite a recovery or a different wallet attempt. */
export function canApplyApprovalPoll(current: TrackedApproval | null, observed: TrackedApproval): boolean {
  return !!current && approvalBlocksSubmission(current) && current.createdAt === observed.createdAt &&
    current.address.toLowerCase() === observed.address.toLowerCase() && current.chainId === observed.chainId &&
    current.approvalHash === observed.approvalHash && current.amount === observed.amount;
}

export function exactApprovalTransaction(request: ApprovalRequest): ApprovalTransaction {
  const checked = validateRequest(request);
  return { chainId: checked.chainId ?? ARC_APPROVAL_CHAIN_ID, to: approvalToken(checked.chainId), value: 0n, data: encodeFunctionData({ abi: EXACT_APPROVAL_ABI, functionName: "approve", args: [checked.spender ?? RELAY_APPROVAL_SPENDER, BigInt(checked.amount)] }) };
}

/** Also bind candidate chain and block time to the journal in the RPC caller. */
export function isMatchingApprovalTransaction(approval: TrackedApproval, transaction: { from: Address; to: Address | null; input: Hex; value: bigint }): boolean {
  try {
    const checked = parseStoredApproval(serializeApproval(approval), approval.address);
    return transaction.from.toLowerCase() === checked.address.toLowerCase() && transaction.to?.toLowerCase() === checked.token.toLowerCase() && transaction.value === 0n && transaction.input.toLowerCase() === exactApprovalTransaction(checked).data.toLowerCase();
  } catch { return false; }
}

/** Smart-wallet recovery uses the token's own Approval event, never a router's log. */
export function hasMatchingApprovalEvent(approval: TrackedApproval, receipt: { status: "success" | "reverted"; logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[] }): boolean {
  if (receipt.status !== "success") return false;
  try {
    const checked = parseStoredApproval(serializeApproval(approval), approval.address);
    return receipt.logs.some((log) => {
      if (log.address.toLowerCase() !== checked.token.toLowerCase() || log.topics.length !== 3 || !log.topics.every((topic) => HASH.test(topic)) || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) return false;
      try {
        const event = decodeEventLog({ abi: USDC_APPROVAL_EVENT, data: log.data, topics: [log.topics[0], ...log.topics.slice(1)], strict: true });
        return event.args.owner.toLowerCase() === checked.address.toLowerCase() && event.args.spender.toLowerCase() === checked.spender && event.args.value.toString() === checked.amount;
      } catch { return false; }
    });
  } catch { return false; }
}

export function parseStoredApproval(raw: string, address: Address): TrackedApproval {
  try {
    const entry = JSON.parse(raw) as TrackedApproval;
    const request = validateRequest(entry);
    if (entry.version !== 1 || request.address.toLowerCase() !== address.toLowerCase() || !isBridgeChainId(entry.chainId) || typeof entry.token !== "string" || entry.token.toLowerCase() !== approvalToken(entry.chainId).toLowerCase() || !spenderOf(entry.spender) || !Number.isSafeInteger(entry.createdAt) || entry.createdAt <= 0 || !STATUSES.includes(entry.status) || (entry.approvalHash !== undefined && !validHash(entry.approvalHash)) || (entry.status !== "uncertain" && !entry.approvalHash)) throw new Error("invalid record");
    return { ...request, version: 1, chainId: entry.chainId, token: approvalToken(entry.chainId), spender: spenderOf(entry.spender)!, createdAt: entry.createdAt, status: entry.status, ...(entry.approvalHash ? { approvalHash: entry.approvalHash } : {}) };
  } catch { throw new Error("Saved token approval recovery data could not be read. Check the approval before trying again."); }
}

export function serializeApproval(approval: TrackedApproval): string {
  return JSON.stringify(parseStoredApproval(JSON.stringify(approval), approval.address));
}

export type ApprovalObservation = {
  chainId: number;
  allowance: bigint;
  receipt?: { transactionHash: Hex; status: "success" | "reverted" } | null;
};

/**
 * Call with a freshly read allowance and receipt on the saved chain, including after reload.
 * A saved confirmation is never sufficient authority to deposit. An allowance
 * alone cannot resolve an unknown broadcast, so it never enables an automatic retry.
 */
export function reconcileApproval(approval: TrackedApproval, observation: ApprovalObservation): TrackedApproval {
  const checked = parseStoredApproval(serializeApproval(approval), approval.address);
  if (observation.chainId !== checked.chainId || typeof observation.allowance !== "bigint" || observation.allowance < 0n || observation.allowance > MAX_UINT) throw new Error("Could not verify the approval on its source network. Check again before continuing.");
  if (!checked.approvalHash) return { ...checked, status: "uncertain" };
  if (!observation.receipt) return { ...checked, status: "pending" };
  if (!validHash(observation.receipt.transactionHash) || observation.receipt.transactionHash.toLowerCase() !== checked.approvalHash.toLowerCase() || !["success", "reverted"].includes(observation.receipt.status)) throw new Error("The approval receipt did not match the saved transaction.");
  return { ...checked, status: observation.receipt.status === "reverted" ? "reverted" : observation.allowance >= BigInt(checked.amount) ? "confirmed" : "insufficient" };
}

/** Verify a user-supplied mined hash, including a wallet speed-up replacement. */
export function recoverApprovalFromEvidence(approval: TrackedApproval, evidence: {
  chainId: number;
  allowance: bigint;
  transaction: { hash: Hex; from: Address; to: Address | null; input: Hex; value: bigint };
  receipt: { transactionHash: Hex; status: "success" | "reverted"; logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[] };
  blockTimestamp: bigint;
  now: number;
}): TrackedApproval {
  const current = parseStoredApproval(serializeApproval(approval), approval.address);
  if (!approvalBlocksSubmission(current)) throw new Error("The saved approval is already resolved. Review its current status.");
  const hash = evidence.receipt.transactionHash;
  if (evidence.chainId !== current.chainId || !validHash(hash) || evidence.transaction.hash.toLowerCase() !== hash.toLowerCase()) throw new Error("The transaction could not be verified on the approval's network.");
  const blockTime = Number(evidence.blockTimestamp) * 1000;
  // Approvals have no order ID. Never adopt an old approval from before this attempt.
  if (!Number.isSafeInteger(blockTime) || !Number.isSafeInteger(evidence.now) || blockTime < current.createdAt - 30_000 || blockTime > evidence.now + 30_000) throw new Error("This transaction predates the saved approval or your clock differs from the network. Check the hash and device clock.");
  if (!isMatchingApprovalTransaction(current, evidence.transaction) && !hasMatchingApprovalEvent(current, evidence.receipt)) throw new Error("That transaction does not match this wallet's exact token approval.");
  return reconcileApproval({ ...current, approvalHash: hash }, evidence);
}

type StorageAdapter = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type ApprovalSnapshot = { approvals: Record<string, TrackedApproval | null>; errors: Record<string, string | null> };
const EMPTY: ApprovalSnapshot = { approvals: {}, errors: {} };

/** Separate from native/deposit recovery. Call mutating operations under the wallet Web Lock. */
export function createApprovalStore(storage: () => StorageAdapter) {
  let snapshot = EMPTY;
  const listeners = new Set<() => void>();
  function update(address: Address, approval: TrackedApproval | null, error: string | null) {
    const key = address.toLowerCase();
    snapshot = { approvals: { ...snapshot.approvals, [key]: approval }, errors: { ...snapshot.errors, [key]: error } };
    for (const notify of listeners) notify();
  }
  return {
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    remember(approval: TrackedApproval) { update(approval.address, parseStoredApproval(serializeApproval(approval), approval.address), snapshot.errors[approval.address.toLowerCase()] ?? null); },
    read(address: Address): TrackedApproval | null {
      try {
        const raw = storage().getItem(approvalStorageKey(address));
        let approval = raw === null ? null : parseStoredApproval(raw, address);
        const memory = snapshot.approvals[address.toLowerCase()];
        if (approval && memory && approval.createdAt === memory.createdAt && approvalRequestKey(approval) === approvalRequestKey(memory)) {
          // Retain a wallet-returned hash if the post-send storage write failed.
          if (memory.approvalHash && !approval.approvalHash) approval = { ...approval, approvalHash: memory.approvalHash, status: memory.status };
        }
        update(address, approval, null);
        return approval;
      } catch {
        const message = "Token approval recovery storage is unavailable or unreadable. Enable site storage and reload before approving.";
        update(address, snapshot.approvals[address.toLowerCase()] ?? null, message);
        throw new Error(message);
      }
    },
    save(approval: TrackedApproval) {
      // Validate before changing either persistent or in-memory recovery data.
      const raw = serializeApproval(approval);
      try {
        const adapter = storage();
        adapter.setItem(approvalStorageKey(approval.address), raw);
        if (adapter.getItem(approvalStorageKey(approval.address)) !== raw) throw new Error("Storage did not retain approval");
        update(approval.address, approval, null);
      } catch {
        const message = "Could not save token approval recovery details. Keep this page open and check the approval before trying again.";
        update(approval.address, approval, message);
        throw new Error(message);
      }
    },
    remove(address: Address) {
      try { storage().removeItem(approvalStorageKey(address)); update(address, null, null); }
      catch {
        const message = "Could not clear the saved token approval. Enable site storage and reload before trying again.";
        update(address, snapshot.approvals[address.toLowerCase()] ?? null, message);
        throw new Error(message);
      }
    },
  };
}

export type ApprovalDependencies = {
  now: () => number;
  // Return null for expired reviews, changed routes, or any tracked deposit.
  currentRequest: () => ApprovalRequest | null;
  readWallet: () => Promise<{ address?: Address; chainId?: number }>;
  switchChain: (chainId: BridgeChainId) => Promise<unknown>;
  prepare: (request: ApprovalRequest, transaction: ApprovalTransaction) => Promise<ApprovalGas>;
  readApproval: (address: Address) => TrackedApproval | null;
  saveApproval: (approval: TrackedApproval) => void;
  removeApproval: (address: Address) => void;
  send: (request: ApprovalRequest, transaction: ApprovalTransaction, gas: ApprovalGas) => Promise<Hex>;
  phase: (phase: "switching" | "confirming") => void;
};
export type ApprovalResult = { kind: "sent" | "uncertain"; approval: TrackedApproval } | { kind: "rejected" };

function walletRejected(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; current && typeof current === "object" && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    const value = current as { code?: unknown; cause?: unknown };
    if (value.code === 4001 || value.code === "ACTION_REJECTED") return true;
    current = value.cause;
  }
  return false;
}

/**
 * Caller must hold the same per-wallet Web Lock as deposit submission/recovery.
 * This only approves the source chain's one bridge token. After confirmation, request and review a NEW quote;
 * never automatically deposit, and never put this hash in the deposit journal.
 */
export async function submitExactApproval(input: ApprovalRequest, deps: ApprovalDependencies): Promise<ApprovalResult> {
  const request = validateRequest(input);
  const chainId = request.chainId ?? ARC_APPROVAL_CHAIN_ID;
  const transaction = exactApprovalTransaction(request);
  const checkRequest = () => {
    const current = deps.currentRequest();
    if (!current || approvalRequestKey(validateRequest(current)) !== approvalRequestKey(request)) throw new Error("The wallet, route, amount, or quote changed. Review a new quote before approving.");
  };
  checkRequest();
  const existing = deps.readApproval(request.address);
  if (approvalBlocksSubmission(existing)) throw new Error("An approval is already being tracked. Check its status before approving again.");
  let wallet = await deps.readWallet();
  if (wallet.address?.toLowerCase() !== request.address.toLowerCase()) throw new Error("The connected wallet changed. Review a new quote.");
  if (wallet.chainId !== chainId) { deps.phase("switching"); await deps.switchChain(chainId); }
  checkRequest();
  const gas = await deps.prepare(request, transaction);
  if (typeof gas.gas !== "bigint" || gas.gas <= 0n || typeof gas.maxFeePerGas !== "bigint" || gas.maxFeePerGas <= 0n || typeof gas.maxPriorityFeePerGas !== "bigint" || gas.maxPriorityFeePerGas < 0n || gas.maxPriorityFeePerGas > gas.maxFeePerGas) throw new Error("Could not estimate approval gas. Request a new quote.");
  wallet = await deps.readWallet();
  checkRequest();
  if (wallet.address?.toLowerCase() !== request.address.toLowerCase() || wallet.chainId !== chainId) throw new Error("Your wallet account or network changed. Review a new quote.");
  const latest = deps.readApproval(request.address);
  if (approvalBlocksSubmission(latest)) throw new Error("Another approval is now being tracked. Check it before continuing.");
  const createdAt = Math.max(deps.now(), (latest?.createdAt ?? 0) + 1);
  const tracked: TrackedApproval = { ...request, version: 1, chainId, token: approvalToken(chainId), spender: request.spender ?? RELAY_APPROVAL_SPENDER, createdAt, status: "uncertain" };
  serializeApproval(tracked);
  const restore = () => { if (latest) deps.saveApproval(latest); else deps.removeApproval(request.address); };
  try { deps.saveApproval(tracked); }
  catch {
    try { restore(); } catch { /* retain the storage warning; no wallet call happened */ }
    throw new Error("Could not save approval recovery details. No transaction was requested. Enable site storage before trying again.");
  }
  deps.phase("confirming");
  let hash: Hex;
  try {
    hash = await deps.send(request, transaction, gas);
    if (!validHash(hash)) throw new Error("Wallet returned no approval hash");
  } catch (error) {
    if (walletRejected(error)) {
      const current = deps.readApproval(request.address);
      if (current?.createdAt === tracked.createdAt && approvalRequestKey(current) === approvalRequestKey(tracked)) restore();
      return { kind: "rejected" };
    }
    return { kind: "uncertain", approval: tracked };
  }
  const sent: TrackedApproval = { ...tracked, approvalHash: hash, status: "pending" };
  try { deps.saveApproval(sent); } catch { /* durable pre-send record prevents duplicate approval */ }
  return { kind: "sent", approval: sent };
}
