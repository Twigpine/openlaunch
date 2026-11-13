import { isPlainObject, validateArgs, type ObjectSchema } from "./schema.ts";
import {
  failure,
  isJsonRpcId,
  RPC_ERRORS,
  success,
  supportedVersion,
  type JsonRpcId,
  type JsonRpcResponse,
} from "./protocol.ts";

/** A problem with the tool's input (or a missing record), safe to show to the caller. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/**
 * One read-only tool. `run` receives arguments that have already been checked
 * against `inputSchema` (defaults applied), and returns a JSON-serialisable
 * value. Throw `ToolError` for a caller-correctable failure; anything else is
 * reported as a generic tool failure and logged by the route.
 */
export type McpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: ObjectSchema;
  annotations: ToolAnnotations;
  run: (args: Record<string, unknown>) => Promise<unknown>;
};

export type McpServerInfo = { name: string; version: string };

export type McpServerOptions = {
  tools: readonly McpTool[];
  serverInfo: McpServerInfo;
  instructions?: string;
  /** Called when a tool throws something other than `ToolError`. Never sent to the caller. */
  onToolError?: (tool: string, error: unknown) => void;
};

type Message = Record<string, unknown>;

function invalid(id: JsonRpcId | null, message: string): JsonRpcResponse {
  return failure(id, RPC_ERRORS.invalidRequest, message);
}

function paramsObject(params: unknown): Record<string, unknown> | null {
  return params === undefined ? {} : isPlainObject(params) ? params : null;
}

/**
 * Build a stateless MCP request handler. The returned `handle` takes one
 * decoded JSON-RPC value and returns one response, or null when the message is
 * a notification (which JSON-RPC forbids answering).
 */
export function createMcpServer(options: McpServerOptions): { handle: (value: unknown) => Promise<JsonRpcResponse | null> } {
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const publicTools = options.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));

  async function handle(value: unknown): Promise<JsonRpcResponse | null> {
    // MCP 2025-06-18 does not use JSON-RPC batching; reject it rather than
    // guessing at an order.
    if (Array.isArray(value)) return invalid(null, "JSON-RPC batches are not supported");
    if (!isPlainObject(value)) return invalid(null, "A JSON-RPC request must be an object");
    const message = value as Message;
    if (message.jsonrpc !== "2.0") return invalid(null, 'jsonrpc must be "2.0"');
    if (typeof message.method !== "string" || message.method.length === 0) return invalid(null, "method must be a non-empty string");

    const notification = !Object.hasOwn(message, "id");
    const id = notification ? null : isJsonRpcId(message.id) ? message.id : null;
    if (!notification && id === null) return invalid(null, "id must be a string or a number");
    // A notification is never answered, including one this server does not
    // know: JSON-RPC has no way to say so.
    if (notification) return null;

    const requestId = id as JsonRpcId;
    const params = paramsObject(message.params);
    if (params === null) return failure(requestId, RPC_ERRORS.invalidParams, "params must be an object");

    switch (message.method) {
      case "initialize":
        return success(requestId, {
          protocolVersion: supportedVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: options.serverInfo,
          ...(options.instructions ? { instructions: options.instructions } : {}),
        });

      case "ping":
        return success(requestId, {});

      case "tools/list":
        return success(requestId, { tools: publicTools });

      case "tools/call": {
        if (typeof params.name !== "string" || params.name.length === 0) {
          return failure(requestId, RPC_ERRORS.invalidParams, "tools/call needs a tool name");
        }
        const tool = byName.get(params.name);
        if (!tool) return failure(requestId, RPC_ERRORS.invalidParams, `unknown tool: ${params.name}`);
        const rawArgs = params.arguments ?? {};
        if (!isPlainObject(rawArgs)) {
          return toolFailure(requestId, "tool arguments must be an object");
        }
        const checked = validateArgs(tool.inputSchema, rawArgs);
        if (!checked.ok) return toolFailure(requestId, checked.error);
        let result: unknown;
        try {
          result = await tool.run(checked.value);
        } catch (error) {
          if (error instanceof ToolError) return toolFailure(requestId, error.message);
          options.onToolError?.(tool.name, error);
          return toolFailure(requestId, `${tool.name} could not complete; try again shortly`);
        }
        let text: string;
        try {
          text = JSON.stringify(result, null, 2) ?? "null";
        } catch {
          options.onToolError?.(tool.name, new Error("tool result is not JSON-serialisable"));
          return toolFailure(requestId, `${tool.name} returned a value that could not be encoded`);
        }
        return success(requestId, { content: [{ type: "text", text }], isError: false });
      }

      default:
        return failure(requestId, RPC_ERRORS.methodNotFound, `method not found: ${message.method}`);
    }
  }

  return { handle };
}

/** A tool execution error: valid JSON-RPC, `isError: true` in the tool result, so the model can correct itself. */
function toolFailure(id: JsonRpcId, message: string): JsonRpcResponse {
  return success(id, { content: [{ type: "text", text: message }], isError: true });
}
