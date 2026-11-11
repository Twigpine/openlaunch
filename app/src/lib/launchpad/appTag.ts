/**
 * Whether a swap was made in the openlaunch app (pure; node --test loads this directly; relative imports only).
 *
 * Every transaction the app sends carries its ERC-8021 builder-code suffix (chainPublic.BUILDER_DATA_SUFFIX) on the
 * calldata. A swap counts as in-app when:
 *   - the transaction was sent to the chain's Universal Router and its input ends with the suffix (a wallet sending
 *     its own transaction), or with the suffix followed only by another ERC-8021 suffix (a wallet that appends a
 *     builder code of its own); the same bytes inside the swap's arguments do not count, or
 *   - it was sent to an ERC-4337 EntryPoint, and the user operation of the account the swap is credited to calls the
 *     Universal Router with the suffix (a smart wallet: the app's call, suffix and all, sits inside the operation; ABI
 *     encoding pads that call, so there the suffix is never last and the router address and the suffix are looked
 *     for anywhere in the callData; an operation calling a bot contract or an aggregator does not count).
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
    const router = bare(p.router);
    const senders = args[0].filter((op) => { const cd = op.callData.toLowerCase(); return cd.includes(needle) && cd.includes(router); }).map((op) => op.sender.toLowerCase());
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
