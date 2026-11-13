/**
 * MCP (Model Context Protocol) constants and JSON-RPC 2.0 envelopes.
 *
 * The server is deliberately stateless: it answers one POST at a time, never
 * opens an SSE stream, and never issues server-to-client requests. That is a
 * valid MCP transport (the spec allows a JSON response instead of an SSE
 * stream) and it keeps the endpoint behind the same global request caps as the
 * rest of the JSON API.
 *
 * Versions are negotiated, not assumed: `initialize` echoes the client's
 * version when this server speaks it and otherwise offers the newest one it
 * knows, so an older client can disconnect with a reason instead of failing
 * halfway through a tool call.
 */

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];
export const MCP_LATEST_PROTOCOL_VERSION: McpProtocolVersion = MCP_PROTOCOL_VERSIONS[0];

export type JsonRpcId = string | number;

export type JsonRpcSuccess = { jsonrpc: "2.0"; id: JsonRpcId; result: unknown };

export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
};

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** JSON-RPC 2.0 and MCP error codes used by this server. */
export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function failure(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** True for a protocol version this server speaks. */
export function isSupportedProtocolVersion(raw: unknown): raw is McpProtocolVersion {
  return typeof raw === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(raw);
}

/** A protocol version this server speaks (used for `initialize`). */
export function supportedVersion(raw: unknown): McpProtocolVersion {
  return isSupportedProtocolVersion(raw) ? raw : MCP_LATEST_PROTOCOL_VERSION;
}

/** True when a JSON-RPC id is a string or a number, as MCP requires. */
export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
