import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { resetRateLimitsForTests } from "@/lib/rateLimit";
import { GET, OPTIONS, POST } from "./route.ts";

const URL_ = "http://localhost/api/mcp";

function post(body: unknown, headers: Record<string, string> = {}, ip = "mcp-test"): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
    body: JSON.stringify(body),
  });
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };

beforeEach(() => resetRateLimitsForTests());

test("POST initialize returns the negotiated protocol and no-store headers", async () => {
  const res = await POST(post(initialize));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = (await res.json()) as { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } } };
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.equal(body.result.serverInfo.name, "openlaunch");
});

test("POST tools/list advertises read-only tools without their implementation", async () => {
  const res = await POST(post({ jsonrpc: "2.0", id: "list", method: "tools/list" }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { tools: Array<Record<string, unknown>> } };
  assert.ok(body.result.tools.length >= 8);
  assert.ok(body.result.tools.every((tool) => tool.annotations && (tool.annotations as { readOnlyHint: boolean }).readOnlyHint === true));
  assert.ok(body.result.tools.every((tool) => !("run" in tool)));
});

test("notifications get 202 with no body", async () => {
  const res = await POST(post({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("a browser origin is checked; non-browser clients and the site origin are allowed", async () => {
  const evil = await POST(post(initialize, { origin: "https://evil.example" }));
  assert.equal(evil.status, 403);
  const body = (await evil.json()) as { error: { code: number } };
  assert.equal(body.error.code, -32600);

  const site = await POST(post(initialize, { origin: "https://openlaunch.lol" }));
  assert.equal(site.status, 200);
  const www = await POST(post(initialize, { origin: "https://www.openlaunch.lol" }));
  assert.equal(www.status, 200);
});

test("content type, parse errors, batches and unknown methods are rejected cleanly", async () => {
  const wrongType = await POST(post(initialize, { "content-type": "text/plain" }));
  assert.equal(wrongType.status, 415);

  const malformed = await POST(new Request(URL_, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "mcp-test" }, body: "{" }));
  assert.equal(malformed.status, 400);
  assert.equal(((await malformed.json()) as { error: { code: number } }).error.code, -32700);

  const batch = await POST(post([initialize]));
  assert.equal(batch.status, 200);
  assert.equal(((await batch.json()) as { error: { code: number } }).error.code, -32600);

  const unknown = await POST(post({ jsonrpc: "2.0", id: 9, method: "resources/list" }));
  assert.equal(unknown.status, 200);
  assert.equal(((await unknown.json()) as { error: { code: number } }).error.code, -32601);
});

test("a tool call returns text content; an invalid tool call stays a tool error", async () => {
  const res = await POST(post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_points_leaderboard", arguments: {} } }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };
  // No DATABASE_URL in tests: no public season is the empty shape, not an error.
  assert.equal(body.result.isError, false);
  assert.equal(body.result.content[0].type, "text");
  const parsed = JSON.parse(body.result.content[0].text) as { season: null; board: string; rows: unknown[] };
  assert.equal(parsed.season, null);
  assert.equal(parsed.board, "creator");
  assert.deepEqual(parsed.rows, []);

  const invalid = await POST(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_launch", arguments: { chain: "base" } } }));
  assert.equal(invalid.status, 200);
  const invalidBody = (await invalid.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(invalidBody.result.isError, true);
  assert.match(invalidBody.result.content[0].text, /token/);
});

test("the IP rate limit is 120 requests a minute", async () => {
  for (let i = 0; i < 120; i += 1) {
    const ok = await POST(post({ jsonrpc: "2.0", id: i, method: "ping" }, {}, "rate-ip"));
    assert.equal(ok.status, 200);
  }
  const limited = await POST(post({ jsonrpc: "2.0", id: 121, method: "ping" }, {}, "rate-ip"));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
});

test("GET and OPTIONS do not pretend to be an MCP stream", async () => {
  const get = GET();
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal(OPTIONS().status, 204);
});
