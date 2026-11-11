/**
 * Whether a swap was made in the openlaunch app (pure; node --test loads this directly; relative imports only).
 *
 * Every transaction the app sends carries its ERC-8021 builder-code suffix (chainPublic.BUILDER_DATA_SUFFIX) on the
 * calldata. A swap counts as in-app when:
 *   - the transaction was sent to the chain's Universal Router and its input ends with the suffix (a wallet sending
 *     its own transaction), or with the suffix followed only by another ERC-8021 suffix (a wallet that appends a
 *     builder code of its own); the same bytes inside the swap's arguments do not count, or
 *   - it was sent to an ERC-4337 EntryPoint, and the user operation of the account the swap is credited to makes a
 *     call TO the Universal Router whose data ends with the suffix, read by decoding the account's call
 *     (execute(address,uint256,bytes) of Coinbase Smart Wallet and SimpleAccount, or one of their executeBatch forms).
 *     An operation calling a bot contract or an aggregator, one that only names the router in its arguments, or a
 *     smart account whose call format is not one of those, does not count.
 * Anything else (an aggregator, a bot contract, another front end's smart-wallet trade) is not in-app.
 *
 * The suffix is public, so anyone can copy it: this is a label for a small, capped points bonus, never proof. It is
 * worked out once per transaction and only its result is kept (the input itself can be kilobytes).
 */
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { ENTRY_POINTS } from "./attribution.ts";

/** handleOps for v0.6 (UserOperation) and v0.7+ (PackedUserOperation): different tuples, so different selectors. */
export const HANDLE_OPS_ABI = parseAbi([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,uint256 callGasLimit,uint256 verificationGasLimit,uint256 preVerificationGas,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)",
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)",
]);

/** The smart-account call formats read for the app tag (Coinbase Smart Wallet; SimpleAccount v0.6 and v0.7). */
export const ACCOUNT_CALL_ABI = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
  "function executeBatch(address[] dest, bytes[] func)",
  "function executeBatch(address[] dest, uint256[] value, bytes[] func)",
]);

/** The (target, data) calls a smart account's operation makes, or [] for a call format not read here. */
export function accountCalls(callData: string): { target: string; data: string }[] {
  try {
    const d = decodeFunctionData({ abi: ACCOUNT_CALL_ABI, data: callData as Hex });
    if (d.functionName === "execute") return [{ target: (d.args[0] as string).toLowerCase(), data: (d.args[2] as string).toLowerCase() }];
    const a = d.args as readonly unknown[];
    if (a.length === 1) return (a[0] as readonly { target: string; data: string }[]).map((c) => ({ target: c.target.toLowerCase(), data: c.data.toLowerCase() }));
    const targets = a[0] as readonly string[];
    const datas = (a.length === 2 ? a[1] : a[2]) as readonly string[];
    return targets.map((t, i) => ({ target: t.toLowerCase(), data: (datas[i] ?? "0x").toLowerCase() }));
  } catch {
    return [];
  }
}

/** What one transaction says about the app: `direct` for a wallet's own router call, `senders` for smart wallets. */
export type AppTag = { direct: boolean; senders: readonly string[] };

const NONE: AppTag = { direct: false, senders: [] };

/** ERC-8021's closing marker: the last 16 bytes of every builder-code suffix. */
const ERC8021_MARKER = "80218021802180218021802180218021";
/** The longest tail another wallet's suffix may add after ours (hex characters: 256 bytes). */
const MAX_TAIL_HEX = 512;

/** Whether `input` ends with `needle`, or with `needle` followed only by another ERC-8021 suffix. */
export function endsWithSuffix(input: string, needle: string): boolean {
  const at = input.lastIndexOf(needle);
  if (at < 0) return false;
  const rest = input.slice(at + needle.length);
  return rest === "" || (rest.length % 2 === 0 && rest.length <= MAX_TAIL_HEX && rest.endsWith(ERC8021_MARKER));
}

/** The suffix as bare lowercase hex (no 0x), for searching an input. */
function bare(suffix: string): string {
  const s = suffix.toLowerCase();
  return s.startsWith("0x") ? s.slice(2) : s;
}

/** The app tag of a transaction from its target, input, the chain's Universal Router and the builder suffix. */
export function appTagOf(p: { to: string | null; input: string; router: string; suffix: string }): AppTag {
  const to = p.to?.toLowerCase() ?? null;
  const needle = bare(p.suffix);
  if (!to || needle.length === 0) return NONE;
  const input = p.input.toLowerCase();
  if (to === p.router.toLowerCase()) return { direct: endsWithSuffix(input, needle), senders: [] };
  if (!ENTRY_POINTS.has(to) || !input.includes(needle)) return NONE; // cheap: no suffix anywhere, no operation has it
  try {
    const { args } = decodeFunctionData({ abi: HANDLE_OPS_ABI, data: p.input as Hex });
    const router = p.router.toLowerCase();
    // the same call must go to the router and carry the suffix at its end, as a wallet's own router call would
    const senders = args[0].filter((op) => accountCalls(op.callData).some((c) => c.target === router && endsWithSuffix(c.data, needle))).map((op) => op.sender.toLowerCase());
    return { direct: false, senders: [...new Set(senders)] };
  } catch {
    return NONE; // handleAggregatedOps, or an input that is not a bundle: not tagged
  }
}

/**
 * Whether the swap credited to `trader` (by attribution.ts, `via` "userop" when credited to a smart wallet) is
 * in-app. Null when the transaction's input was not read (unknown: written as NULL, which never counts).
 */
export function swapInApp(tag: AppTag | null, trader: string | null, via: string | null): boolean | null {
  if (tag === null) return null;
  if (!trader) return null;
  return via === "userop" ? tag.senders.includes(trader.toLowerCase()) : tag.direct;
}
