import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { HttpRequestError } from "viem";
import { getMock, resetMock } from "../../../lib/db-mock.ts";

const token = "0x2222222222222222222222222222222222222222";
const launcher = "0x1111111111111111111111111111111111111111";
const tx = `0x${"ab".repeat(32)}`;
const input = { chain: "base", launcher, salt: `0x${"cd".repeat(32)}`, name: "Test launch", symbol: "TEST" };
const secret = "synthetic-rpc-key-do-not-disclose";
const diagnostic = `Authorization: Bearer ${secret}; database host: private-db.internal`;
const failures = [
  ["viem transport error", new HttpRequestError({ url: `https://rpc.example.test/v2/${secret}`, details: diagnostic })],
  ["plain Error", new Error(diagnostic)],
  ["thrown string", diagnostic],
  ["thrown object", { toString: () => diagnostic }],
] as const;

let metaPost: typeof import("./meta/route.ts").POST;
let syncPost: typeof import("./sync/route.ts").POST;
let healthGet: typeof import("../health/route.ts").GET;
let configuredChains: typeof import("../../../lib/launchpad/config.ts").CONFIGURED_CHAINS;
let lastError: string | null = null;
let sequence = 0;
const previousEnv = new Map<string, string | undefined>();

before(async () => {
  // Configuration is read at import time. Only the test's Base chain is enabled.
  const env: Record<string, string | undefined> = {
    NEXT_PUBLIC_LAUNCH_FACTORY: launcher,
    NEXT_PUBLIC_LAUNCH_LOCKER: token,
    LAUNCH_DEPLOY_BLOCK: "10",
    LAUNCH_SYNC_CONFIRMATIONS: "2",
    LAUNCH_SYNC_CONFIRMATIONS_BASE: "2",
  };
  for (const chain of ["ROBINHOOD", "ARC", "ELYSIUM"]) {
    env[`NEXT_PUBLIC_LAUNCH_FACTORY_${chain}`] = undefined;
    env[`NEXT_PUBLIC_LAUNCH_LOCKER_${chain}`] = undefined;
  }
  for (const [key, value] of Object.entries(env)) {
    previousEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  [{ POST: metaPost }, { POST: syncPost }, { GET: healthGet }, { CONFIGURED_CHAINS: configuredChains }] = await Promise.all([
    import("./meta/route.ts"), import("./sync/route.ts"), import("../health/route.ts"), import("../../../lib/launchpad/config.ts"),
  ]);
});

after(() => {
  resetMock();
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function query(sql: string, values: unknown[]): Promise<unknown[]> {
  if (sql.includes("INSERT INTO bb_launch_meta")) return [{ token }];
  if (sql.includes("SELECT cursor_block")) return [{ cursor_block: 0n, reorg_version: 1, reorg_generation: 0n, rebuilding_until: null }];
  if (sql.includes("last_error = ?")) lastError = String(values[1]);
  if (sql.includes("last_error = NULL") || sql.includes("last_error = CASE WHEN cursor_block <=")) lastError = null;
  if (sql.includes("select chain_id, cursor_block, head_block")) return [{ chain_id: 8453, cursor_block: 10n, head_block: 12n, last_run_at: "2026-01-01T00:00:00Z", last_error: lastError }];
  if (sql.includes("pg_try_advisory_lock")) return [{ ok: false }];
  return [];
}

beforeEach(() => {
  resetMock();
  lastError = null;
  process.env.LAUNCH_DEPLOY_BLOCK = "10";
  getMock().query = query;
  getMock().publicClient = {
    readContract: async () => token,
    getBlockNumber: async () => 12n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: tx, timestamp: 1_700_000_000n }),
    getLogs: async () => [],
    // Main reads calldata alongside the receipt to attribute in-app swaps.
    getTransaction: async () => ({ from: launcher, to: token, input: "0x" }),
    getTransactionReceipt: async () => ({ status: "success", transactionHash: tx, blockNumber: 10n, blockHash: tx, from: launcher, to: token, logs: [] }),
  };
});

function request(path: string, body?: unknown): Request {
  return new Request(`http://localhost/api/launch/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `disclosure-test-${++sequence}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

for (const [kind, failure] of failures) {
  test(`metadata hides ${kind} from the real prediction/save chain`, async () => {
    getMock().publicClient = { readContract: async () => { throw failure; } };
    const response = await metaPost(request("meta", input));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "metadata save failed" });
  });

  test(`sync polling hides ${kind} in per-chain results and health`, async (t) => {
    t.mock.method(console, "error", () => {});
    getMock().publicClient = { getBlockNumber: async () => { throw failure; } };
    const response = await syncPost(request("sync"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { base: { status: "skipped", reason: "sync_failed" } });
    assert.ok(lastError, "the indexer still records a failure for health monitoring");
    const health = await healthGet();
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, false);
    assert.deepEqual(body.alerts, ["sync_error"]);
    assert.equal(body.sync.last_error, "sync_failed");
    assert.equal(body.chains[0].last_error, "sync_failed");
    assert.doesNotMatch(JSON.stringify(body), /synthetic-rpc-key|Authorization|private-db/);
  });

  test(`receipt sync hides ${kind} after reading a valid receipt`, async () => {
    getMock().query = async () => { throw failure; };
    const response = await syncPost(request(`sync?chain=base&tx=${tx}`));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "sync failed" });
  });

  test(`sync route hides ${kind} if the overall poll rejects`, async (t) => {
    Object.defineProperty(configuredChains, "map", { configurable: true, value: () => { throw failure; } });
    t.after(() => { Reflect.deleteProperty(configuredChains, "map"); });
    const response = await syncPost(request("sync"));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "sync failed" });
  });
}

test("receipt sync reports advisory contention as pending without exposing database diagnostics", async () => {
  const queries: string[] = [];
  getMock().query = async (sql, values) => {
    queries.push(sql);
    if (sql.includes("pg_advisory_xact_lock")) throw Object.assign(new Error(diagnostic), { code: "55P03" });
    return query(sql, values);
  };
  const response = await syncPost(request(`sync?chain=base&tx=${tx}`));
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("retry-after"), "2");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "pending" });
  assert.equal(queries.some((sql) => sql.includes("LOCK TABLE") || sql.includes("INSERT INTO bb_launch_sync_cursor")), false);
});

test("metadata success preserves the URI and predicted token", async () => {
  const response = await metaPost(request("meta", input));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.token, token);
  assert.ok(body.uri.endsWith(`/api/launch/meta/${launcher}/${input.salt}`));
});

test("metadata retains actionable key and token conflict messages", async () => {
  for (const ownerExists of [true, false]) {
    getMock().query = async (sql) => {
      if (sql.includes("SELECT launcher") && (ownerExists || sql.includes("AND token ="))) {
        return [{ launcher, name: "Different launch", symbol: "OTHER" }];
      }
      return [];
    };
    const response = await metaPost(request("meta", input));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /already registered/);
  }
});

test("metadata retains validation and malformed JSON errors", async () => {
  const invalid = await metaPost(request("meta", { ...input, name: "" }));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /^name:/);
  const malformed = await metaPost(new Request("http://localhost/api/launch/meta", { method: "POST", body: "{" }));
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "bad json" });
});

test("sync success still advances a range and returns its counters", async () => {
  lastError = "previous failure";
  const response = await syncPost(request("sync"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { base: {
    status: "synced", from: "11", to: "10", head: "12", launches: 0, swaps: 0, fees: 0, boosts: 0, caught_up: true,
  } });
  assert.equal(lastError, null, "successful indexing clears the previous failure");
});

test("receipt sync preserves applied, missing and reverted outcomes", async () => {
  const response = await syncPost(request(`sync?chain=base&tx=${tx}`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "applied", launches: 0, swaps: 0, fees: 0, boosts: 0, tokens: [] });
  getMock().publicClient = { ...getMock().publicClient, getTransactionReceipt: async () => { throw new Error(diagnostic); } };
  assert.deepEqual(await (await syncPost(request(`sync?tx=${tx}`))).json(), { status: "not_found" });
  getMock().publicClient = { ...getMock().publicClient, getTransactionReceipt: async () => ({ status: "reverted" }) };
  assert.deepEqual(await (await syncPost(request(`sync?tx=${tx}`))).json(), { status: "reverted" });
});

test("sync keeps validation and configuration skip reasons", async () => {
  for (const [path, error] of [["sync?tx=bad", "bad tx"], [`sync?chain=bad&tx=${tx}`, "bad chain"]]) {
    const response = await syncPost(request(path));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
  }
  delete process.env.LAUNCH_DEPLOY_BLOCK;
  const response = await syncPost(request("sync"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { base: { status: "skipped", reason: "deploy_block_unset" } });
});

test("health hides previously stored diagnostics in both response representations", async (t) => {
  t.mock.method(console, "error", () => {});
  lastError = diagnostic;
  const response = await healthGet();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sync.last_error, "sync_failed");
  assert.equal(body.chains[0].last_error, "sync_failed");
  assert.deepEqual(body.alerts, ["sync_error"]);
  assert.equal(body.sync.cursor_block, 10);
  assert.equal(body.sync.head_block, 12);
  assert.equal(body.sync.lag_blocks, 2);
});
