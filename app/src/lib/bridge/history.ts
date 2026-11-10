import { formatUnits, type Address, type Hex } from "viem";
import type { TrackedBridgeTransfer } from "./client";
import { bridgeCurrency, bridgeCurrencyAsset, bridgeTransferInputCurrency, isBridgeAssetSupported, isBridgeChainId, isBridgeDestination, type BridgeAsset, type BridgeChainId, type BridgeDestinationId, type BridgeStatus } from "./types";

/**
 * Transfer history. Two sources, one shape: transfers this browser sent (a small ledger beside the recovery record,
 * so it works with no server and no key), and Relay's own list for the wallet (GET /requests/v3, which needs the
 * integrator's API key and is switched off without it). Everything here is pure so the server route, the store and
 * the board all apply the same rules: only routes this bridge supports, amounts in their real units, a settled
 * status never rolled back, and nothing shown that neither source reported.
 */

export type BridgeHistoryStatus = BridgeStatus | "uncertain";
export type BridgeHistoryEntry = {
  /** Circle's CCTP, or Relay when omitted. A Circle row has no Relay page; its `requestId` is this app's own. */
  provider?: "cctp";
  requestId: Hex;
  originChainId: BridgeChainId;
  destinationChainId: BridgeDestinationId;
  originAsset: BridgeAsset;
  destinationAsset: BridgeAsset;
  /** Sent, in the source currency's base units. */
  amountIn: string;
  inDecimals: 6 | 18;
  /** What arrived ("received", reported by Relay), what the accepted quote expected ("quoted"), or unknown. */
  amountOut: string | null;
  outDecimals: 6 | 18;
  outKind: "received" | "quoted" | null;
  status: BridgeHistoryStatus;
  /** The source network rejected the deposit itself: nothing was bridged. */
  reverted: boolean;
  createdAt: number;
  sourceHash: Hex | null;
  destinationHashes: Hex[];
  /** Set only when funds went to a different address than the sending wallet. */
  recipient: Address | null;
};

export const BRIDGE_HISTORY_LIMIT = 20;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9]\d{0,77})$/;
const STATUSES: readonly BridgeHistoryStatus[] = ["waiting", "depositing", "pending", "submitted", "delayed", "success", "refund", "failure", "uncertain"];
const SETTLED: readonly BridgeHistoryStatus[] = ["success", "refund", "failure"];

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isHash = (value: unknown): value is Hex => typeof value === "string" && HASH.test(value);
const isUint = (value: unknown, positive = false): value is string => typeof value === "string" && UINT.test(value) && BigInt(value) < 1n << 256n && (!positive || value !== "0");
export const historySettled = (status: BridgeHistoryStatus) => SETTLED.includes(status);

/**
 * A ledger row for a tracked transfer, or null while there is no evidence anything left the wallet: a record is kept
 * only once it has a source transaction hash or Relay has settled it, so a cancelled wallet prompt never shows up.
 */
export function historyFromTransfer(transfer: TrackedBridgeTransfer, quotedOut: string | null = null): BridgeHistoryEntry | null {
  if (!transfer.sourceHash && !historySettled(transfer.status)) return null;
  if (!isBridgeDestination(transfer.destinationChainId)) return null;
  const input = bridgeTransferInputCurrency(transfer);
  const output = bridgeCurrency(transfer.destinationChainId, transfer.destinationAsset, "output");
  const out = quotedOut !== null && isUint(quotedOut) ? quotedOut : null;
  return {
    ...(transfer.provider ? { provider: transfer.provider } : {}),
    requestId: transfer.requestId, originChainId: transfer.originChainId, destinationChainId: transfer.destinationChainId,
    originAsset: input.symbol, destinationAsset: output.symbol, amountIn: transfer.amount, inDecimals: input.decimals,
    amountOut: out, outDecimals: output.decimals, outKind: out === null ? null : "quoted",
    status: transfer.status, reverted: transfer.failureReason === "source-reverted", createdAt: transfer.createdAt,
    sourceHash: transfer.sourceHash ?? null, destinationHashes: [...transfer.destinationHashes], recipient: null,
  };
}

/** One row, checked field by field and copied, or null. A bad row is dropped on its own; history is never all or nothing. */
export function parseHistoryEntry(value: unknown): BridgeHistoryEntry | null {
  if (!isObject(value)) return null;
  const v = value;
  if (!isHash(v.requestId) || !isBridgeChainId(v.originChainId) || !isBridgeDestination(v.destinationChainId) || v.originChainId === v.destinationChainId) return null;
  if (!isBridgeAssetSupported(v.originChainId, v.originAsset) || !isBridgeAssetSupported(v.destinationChainId, v.destinationAsset)) return null;
  // Arc's first deposits were native, 18-decimal USDC; every other source amount uses the asset's input decimals.
  const inputDecimals = bridgeCurrency(v.originChainId, v.originAsset, "input").decimals;
  if (v.inDecimals !== inputDecimals && !(v.originChainId === 5042 && v.inDecimals === 18)) return null;
  if (v.outDecimals !== bridgeCurrency(v.destinationChainId, v.destinationAsset, "output").decimals) return null;
  if (!isUint(v.amountIn, true) || !(v.amountOut === null || isUint(v.amountOut)) || !(v.outKind === null ? v.amountOut === null : (v.outKind === "received" || v.outKind === "quoted") && v.amountOut !== null)) return null;
  if (!STATUSES.includes(v.status as BridgeHistoryStatus) || typeof v.reverted !== "boolean" || (v.reverted && v.status !== "failure")) return null;
  if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt) || v.createdAt <= 0) return null;
  if (!(v.sourceHash === null || isHash(v.sourceHash)) || !Array.isArray(v.destinationHashes) || v.destinationHashes.length > 50 || !v.destinationHashes.every(isHash)) return null;
  if (!(v.recipient === null || (typeof v.recipient === "string" && ADDRESS.test(v.recipient)))) return null;
  if (v.provider !== undefined && v.provider !== "cctp") return null;
  return {
    ...(v.provider === "cctp" ? { provider: "cctp" as const } : {}),
    requestId: v.requestId, originChainId: v.originChainId, destinationChainId: v.destinationChainId, originAsset: v.originAsset, destinationAsset: v.destinationAsset,
    amountIn: v.amountIn, inDecimals: v.inDecimals as 6 | 18, amountOut: v.amountOut as string | null, outDecimals: v.outDecimals as 6 | 18, outKind: v.outKind as BridgeHistoryEntry["outKind"],
    status: v.status as BridgeHistoryStatus, reverted: v.reverted, createdAt: v.createdAt, sourceHash: v.sourceHash as Hex | null,
    destinationHashes: [...v.destinationHashes as Hex[]], recipient: v.recipient as Address | null,
  };
}

const sameRequest = (a: BridgeHistoryEntry, b: BridgeHistoryEntry) => a.requestId.toLowerCase() === b.requestId.toLowerCase();
const rank = (status: BridgeHistoryStatus) => historySettled(status) ? 2 : status === "uncertain" ? 0 : 1;
const outRank = (kind: BridgeHistoryEntry["outKind"]) => kind === "received" ? 2 : kind === "quoted" ? 1 : 0;

/**
 * Two observations of one transfer. `next` wins, except that a settled status is never replaced by an unsettled one
 * (a late or lagging answer cannot roll a transfer back), a delivered amount beats a quoted one, and hashes add up.
 */
export function combineHistory(prior: BridgeHistoryEntry, next: BridgeHistoryEntry): BridgeHistoryEntry {
  const status = rank(prior.status) > rank(next.status) ? prior : next;
  const out = outRank(prior.outKind) > outRank(next.outKind) ? prior : next;
  return {
    ...prior, ...next, status: status.status, reverted: status.reverted,
    amountOut: out.amountOut, outKind: out.outKind,
    createdAt: Math.min(prior.createdAt, next.createdAt),
    sourceHash: next.sourceHash ?? prior.sourceHash,
    destinationHashes: [...new Set([...prior.destinationHashes, ...next.destinationHashes].map((hash) => hash.toLowerCase() as Hex))].slice(0, 50),
    recipient: next.recipient ?? prior.recipient,
  };
}

const newestFirst = (entries: BridgeHistoryEntry[]) => [...entries].sort((a, b) => b.createdAt - a.createdAt).slice(0, BRIDGE_HISTORY_LIMIT);

/** Add or update one row in a ledger, newest first, capped. */
export function upsertHistory(entries: readonly BridgeHistoryEntry[], entry: BridgeHistoryEntry): BridgeHistoryEntry[] {
  const prior = entries.find((row) => sameRequest(row, entry));
  return newestFirst([prior ? combineHistory(prior, entry) : entry, ...entries.filter((row) => row !== prior)]);
}

/** This browser's rows and Relay's rows as one list. Relay is the later observation for a transfer both know. */
export function mergeHistory(browser: readonly BridgeHistoryEntry[], relay: readonly BridgeHistoryEntry[]): BridgeHistoryEntry[] {
  let rows = [...browser];
  for (const entry of relay) rows = upsertHistory(rows, entry);
  return newestFirst(rows);
}

export function parseHistoryLedger(raw: string): BridgeHistoryEntry[] {
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.entries)) throw new Error("Saved bridge history could not be read.");
  let rows: BridgeHistoryEntry[] = [];
  for (const item of value.entries.slice(0, 100)) {
    const entry = parseHistoryEntry(item);
    if (entry) rows = upsertHistory(rows, entry);
  }
  return rows;
}

export function serializeHistoryLedger(entries: readonly BridgeHistoryEntry[]): string {
  return JSON.stringify({ version: 1, entries: newestFirst([...entries]) });
}

export type BridgeHistoryResponse = { relay: "off" } | { relay: "on"; transfers: BridgeHistoryEntry[] };

/** The browser re-checks every row the server sends; an unreadable answer is an error, not an empty history. */
export function validateHistoryResponse(value: unknown): BridgeHistoryResponse {
  if (isObject(value) && value.relay === "off") return { relay: "off" };
  if (!isObject(value) || value.relay !== "on" || !Array.isArray(value.transfers)) throw new Error("Relay history could not be read.");
  return { relay: "on", transfers: newestFirst(value.transfers.slice(0, 100).map(parseHistoryEntry).filter((row): row is BridgeHistoryEntry => row !== null)) };
}

type RelayAmount = { chainId: BridgeChainId; asset: BridgeAsset; decimals: 6 | 18; amount: string };

/** A Relay `{ currency: { chainId, address, decimals }, amount }` this bridge knows, in its own units, or null. */
function relayAmount(value: unknown): RelayAmount | null {
  if (!isObject(value) || !isObject(value.currency)) return null;
  const { chainId, address, decimals } = value.currency;
  if (!isBridgeChainId(chainId) || typeof address !== "string") return null;
  const known = bridgeCurrencyAsset(chainId, address);
  if (!known || (decimals !== undefined && decimals !== known.decimals) || !isUint(value.amount)) return null;
  return { chainId, asset: known.asset, decimals: known.decimals, amount: value.amount };
}

function relayHashes(value: unknown, chainId: BridgeChainId): Hex[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tx): tx is { txHash: Hex } => isObject(tx) && tx.chainId === chainId && isHash(tx.txHash)).map((tx) => tx.txHash).slice(0, 50);
}

/**
 * One request from GET /requests/v3, or null when it is not a transfer this bridge could have made for `wallet`:
 * another wallet, a network or token outside the bridge, or a shape we cannot read. Field names follow Relay's
 * published schema (api.relay.link/documentation/json); none are marked required there, so every one is checked.
 */
export function relayHistoryEntry(value: unknown, wallet: string): BridgeHistoryEntry | null {
  if (!isObject(value) || !isHash(value.id) || !STATUSES.includes(value.status as BridgeHistoryStatus) || value.status === "uncertain") return null;
  const owner = wallet.toLowerCase();
  const sender = [value.user, value.sender].some((who) => typeof who === "string" && who.toLowerCase() === owner);
  if (!sender || typeof value.recipient !== "string" || !ADDRESS.test(value.recipient)) return null;
  const data = isObject(value.data) ? value.data : {};
  const route = isObject(data.route) ? data.route : {};
  const quoted = isObject(route.quoted) ? route.quoted : {};
  const actual = isObject(route.actual) ? route.actual : {};
  const pick = (leg: Record<string, unknown>, side: "origin" | "destination", key: "inputCurrency" | "outputCurrency") => isObject(leg[side]) ? relayAmount((leg[side] as Record<string, unknown>)[key]) : null;
  const sent = pick(quoted, "origin", "inputCurrency");
  const received = value.status === "success" ? pick(actual, "destination", "outputCurrency") : null;
  const expected = pick(quoted, "destination", "outputCurrency");
  const out = received ?? expected;
  if (!sent || sent.amount === "0" || !out || !isBridgeDestination(out.chainId) || out.chainId === sent.chainId) return null;
  if (received && expected && (received.chainId !== expected.chainId || received.asset !== expected.asset)) return null;
  const createdAt = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : Number.NaN;
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  return parseHistoryEntry({
    requestId: value.id, originChainId: sent.chainId, destinationChainId: out.chainId, originAsset: sent.asset, destinationAsset: out.asset,
    amountIn: sent.amount, inDecimals: sent.decimals, amountOut: out.amount, outDecimals: out.decimals, outKind: received ? "received" : "quoted",
    status: value.status, reverted: false, createdAt,
    sourceHash: relayHashes(data.inTxs, sent.chainId)[0] ?? null, destinationHashes: relayHashes(data.outTxs, out.chainId),
    recipient: value.recipient.toLowerCase() === owner ? null : value.recipient,
  });
}

export function parseRelayHistory(value: unknown, wallet: string): BridgeHistoryEntry[] {
  if (!isObject(value) || !Array.isArray(value.requests)) throw new Error("Relay history could not be read.");
  return newestFirst(value.requests.slice(0, 100).map((request) => relayHistoryEntry(request, wallet)).filter((row): row is BridgeHistoryEntry => row !== null));
}

export type HistoryTone = "ok" | "route" | "warn" | "muted";

/** What the board says about a row. Words, not icons, carry the meaning; the tone only colours them. */
export function historyStatus(entry: Pick<BridgeHistoryEntry, "status" | "reverted">): { label: string; tone: HistoryTone } {
  switch (entry.status) {
    case "success": return { label: "Arrived", tone: "ok" };
    case "refund": return { label: "Refunded", tone: "warn" };
    case "failure": return { label: entry.reverted ? "Reverted" : "Failed", tone: "warn" };
    case "delayed": return { label: "Delayed", tone: "warn" };
    case "uncertain": return { label: "Checking", tone: "muted" };
    default: return { label: "In transit", tone: "route" };
  }
}

/**
 * The "received" cell. An amount is shown only with its kind: what Relay reported delivered, or what the quote
 * expected. A refund or a failure shows no destination amount at all, since nothing is known to have arrived.
 */
export function historyReceived(entry: BridgeHistoryEntry): { label: "Received" | "Quoted"; amount: string | null; note: string | null } {
  if (entry.status === "refund") return { label: "Received", amount: null, note: "Refunded" };
  if (entry.status === "failure") return { label: "Received", amount: null, note: entry.reverted ? "Not sent" : "Not delivered" };
  if (entry.amountOut === null) return { label: "Received", amount: null, note: entry.status === "success" ? "Not reported" : "On its way" };
  return { label: entry.outKind === "received" ? "Received" : "Quoted", amount: `${formatHistoryAmount(entry.amountOut, entry.outDecimals)} ${entry.destinationAsset}`, note: null };
}

/** Up to seven decimals, trailing zeros dropped; a dust amount reads as "<0.0000001", never as 0. */
export function formatHistoryAmount(units: string, decimals: 6 | 18): string {
  const [whole, fraction = ""] = formatUnits(BigInt(units), decimals).split(".");
  const cut = fraction.slice(0, 7).replace(/0+$/, "");
  return whole === "0" && !cut && /[1-9]/.test(fraction) ? "<0.0000001" : `${whole}${cut ? `.${cut}` : ""}`;
}
