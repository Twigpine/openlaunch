/** Fixed text per JSON-RPC code: provider wording (which can name plans, keys or internal hosts) never reaches the page. */
const MESSAGES: Record<number, string> = {
  [-32002]: "Transaction simulation failed",
  [-32003]: "Transaction signature verification failed",
  [-32004]: "Block not available for this slot",
  [-32005]: "Solana RPC node is behind; retry shortly",
  [-32007]: "Slot was skipped or is missing",
  [-32009]: "Slot was skipped or is missing",
  [-32014]: "Block status not yet available",
  [-32016]: "Minimum context slot has not been reached",
  [-32602]: "Invalid parameters",
  [429]: "Solana RPC is busy; retry shortly",
};
const FALLBACK = "Solana RPC rejected this request. Check the transaction status before retrying.";

/**
 * A sanitized JSON-RPC error that still says why a send failed: the numeric code, and for sends and simulations the
 * structured transaction error and the program logs (bounded). A refused preflight is a definite "not sent", and the
 * client can only tell that, and show the program's reason, if the code and logs survive the proxy.
 */
export function solanaRpcError(
  error: unknown,
  method: string,
): { code: number; message: string; data?: { err: unknown; logs: string[] } } {
  const e = (error && typeof error === "object" ? error : {}) as {
    code?: unknown;
    data?: unknown;
  };
  const code = typeof e.code === "number" && Number.isSafeInteger(e.code) ? e.code : -32000;
  let message = MESSAGES[code] ?? FALLBACK;
  if (method !== "sendTransaction" && method !== "simulateTransaction")
    return { code, message };
  const data = (e.data && typeof e.data === "object" ? e.data : {}) as {
    err?: unknown;
    logs?: unknown;
  };
  const text = data.err === undefined ? "" : JSON.stringify(data.err);
  // TransactionError is an enum name or a small object such as {"InstructionError":[1,{"Custom":6010}]}.
  const err = text && text.length <= 512 ? data.err : null;
  if (err !== null) message = `${message}: ${typeof err === "string" ? err : text}`;
  const logs = Array.isArray(data.logs)
    ? data.logs
        .filter((line): line is string => typeof line === "string")
        .slice(-60)
        .map((line) => line.slice(0, 300))
    : [];
  return { code, message, data: { err, logs } };
}
