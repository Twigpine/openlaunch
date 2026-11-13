import assert from "node:assert/strict";
import test from "node:test";
import { failure, isJsonRpcId, RPC_ERRORS, supportedVersion, success } from "./protocol.ts";
import { createMcpServer, ToolError, type McpTool } from "./server.ts";
import type { ObjectSchema } from "./schema.ts";

const echoSchema: ObjectSchema = {
  type: "object",
  properties: {
    value: { type: "string", description: "text to echo", minLength: 1, default: "hello" },
  },
  additionalProperties: false,
};

function echoTool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: "echo",
    title: "Echo",
    description: "Echo a value.",
    inputSchema: echoSchema,
    annotations: { readOnlyHint: true },
    run: async (args) => ({ echo: args.value }),
    ...overrides,
  };
}

function server(tools: McpTool[] = [echoTool()], onToolError?: (tool: string, error: unknown) => void) {
  return createMcpServer({
    tools,
    serverInfo: { name: "openlaunch-test", version: "9.9.9" },
    instructions: "read only",
    onToolError,
  });
}

const call = (method: string, params?: unknown, id: string | number = 1) => ({ jsonrpc: "2.0", id, method, params });

test("initialize negotiates a known version and otherwise offers the latest", async () => {
  const s = server();
  const known = await s.handle(call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
  assert.ok(known && "result" in known);
  assert.equal((known.result as { protocolVersion: string }).protocolVersion, "2025-03-26");
  assert.deepEqual((known.result as { serverInfo: unknown }).serverInfo, { name: "openlaunch-test", version: "9.9.9" });
  assert.equal((known.result as { instructions: string }).instructions, "read only");

  const unknown = await s.handle(call("initialize", { protocolVersion: "1999-01-01" }));
  assert.ok(unknown && "result" in unknown);
  assert.equal((unknown.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
});

test("ping and tools/list answer without running a tool", async () => {
  let ran = 0;
  const s = server([echoTool({ run: async () => { ran += 1; return {}; } })]);
  const pong = await s.handle(call("ping"));
  assert.deepEqual(pong, success(1, {}));
  const list = await s.handle(call("tools/list"));
  assert.ok(list && "result" in list);
  const tools = (list.result as { tools: Array<Record<string, unknown>> }).tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "echo");
  assert.equal(tools[0].inputSchema, echoSchema);
  assert.deepEqual(tools[0].annotations, { readOnlyHint: true });
  assert.equal("run" in tools[0], false);
  assert.equal(ran, 0);
});

test("tools/call applies defaults, runs the tool and returns JSON text", async () => {
  let seen: Record<string, unknown> | null = null;
  const s = server([echoTool({ run: async (args) => { seen = args; return { echo: args.value, ok: true }; } })]);
  const r = await s.handle(call("tools/call", { name: "echo", arguments: {} }));
  assert.deepEqual(seen, { value: "hello" });
  assert.ok(r && "result" in r);
  const result = r.result as { content: Array<{ type: string; text: string }>; isError: boolean };
  assert.equal(result.isError, false);
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), { echo: "hello", ok: true });
});

test("invalid tool arguments are a tool execution error, not a protocol error", async () => {
  let ran = 0;
  const s = server([echoTool({ run: async () => { ran += 1; return {}; } })]);
  for (const args of [{ nope: 1 }, { value: 42 }, { value: "" }]) {
    const r = await s.handle(call("tools/call", { name: "echo", arguments: args }, 7));
    assert.ok(r && "result" in r);
    assert.equal(r.id, 7);
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /argument|unknown/);
  }
  assert.equal(ran, 0);
});

test("tool errors are safe to show; unknown errors are generic and reported", async () => {
  const reported: string[] = [];
  const s = server([
    echoTool({ name: "known", run: async () => { throw new ToolError("no such launch"); } }),
    echoTool({ name: "unknown", run: async () => { throw new Error("database password is hunter2"); } }),
  ], (_tool, error) => reported.push(error instanceof Error ? error.message : String(error)));

  const known = await s.handle(call("tools/call", { name: "known", arguments: {} }));
  assert.ok(known && "result" in known);
  assert.deepEqual((known.result as { content: Array<{ text: string }> }).content[0].text, "no such launch");

  const unknown = await s.handle(call("tools/call", { name: "unknown", arguments: {} }));
  assert.ok(unknown && "result" in unknown);
  const text = (unknown.result as { content: Array<{ text: string }> }).content[0].text;
  assert.match(text, /could not complete/);
  assert.doesNotMatch(text, /hunter2/);
  assert.deepEqual(reported, ["database password is hunter2"]);
});

test("a result JSON cannot encode is a tool error, not a 500", async () => {
  const reported: string[] = [];
  const s = server([echoTool({ run: async () => ({ n: 1n }) })], (_tool, error) => reported.push(String(error)));
  const r = await s.handle(call("tools/call", { name: "echo", arguments: {} }));
  assert.ok(r && "result" in r);
  assert.equal((r.result as { isError: boolean }).isError, true);
  assert.equal(reported.length, 1);
});

test("unknown tools and methods get the right JSON-RPC errors", async () => {
  const s = server();
  const tool = await s.handle(call("tools/call", { name: "nope", arguments: {} }, 3));
  assert.deepEqual(tool, failure(3, RPC_ERRORS.invalidParams, "unknown tool: nope"));

  const method = await s.handle(call("resources/list", {}, 4));
  assert.deepEqual(method, failure(4, RPC_ERRORS.methodNotFound, "method not found: resources/list"));

  const params = await s.handle({ ...call("tools/list", "bad"), params: "bad" });
  assert.deepEqual(params, failure(1, RPC_ERRORS.invalidParams, "params must be an object"));
});

test("notifications get no response; malformed requests get invalid-request", async () => {
  const s = server();
  assert.equal(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await s.handle({ jsonrpc: "2.0", method: "made/up" }), null);

  for (const bad of [null, [], "x", { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: null, method: "ping" }]) {
    const r = await s.handle(bad);
    assert.ok(r && "error" in r, JSON.stringify(bad));
    assert.equal(r.error.code, RPC_ERRORS.invalidRequest);
  }
});

test("isJsonRpcId and supportedVersion keep their contracts", () => {
  assert.equal(isJsonRpcId("a"), true);
  assert.equal(isJsonRpcId(0), true);
  assert.equal(isJsonRpcId(null), false);
  assert.equal(isJsonRpcId(Number.NaN), false);
  assert.equal(supportedVersion("2024-11-05"), "2024-11-05");
  assert.equal(supportedVersion("nope"), "2025-06-18");
});
