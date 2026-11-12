import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionResult, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, parseEventLogs, type Hex, type Log } from "viem";
import { getMock, maybeDb, resetMock } from "@/lib/db-mock";
import { ERC20_MIN_ABI, LAUNCH_FACTORY_ABI } from "./abi";

const FACTORY = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const LAUNCHER = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"55".repeat(32)}` as Hex;
const ZERO = "0x0000000000000000000000000000000000000000";
const POOL = `0x${"66".repeat(32)}` as Hex;
type Row = { token: string; name: string; symbol: string; metadata_uri: string; token_id: bigint; pool_id: string; quote: string; lp_fee: number; recipients: unknown[] };

function launched(metadataURI: string, token = TOKEN, logIndex = 0): Log {
  const event = LAUNCH_FACTORY_ABI.find((x) => x.type === "event" && x.name === "Launched")!;
  return {
    address: FACTORY,
    topics: encodeEventTopics({ abi: LAUNCH_FACTORY_ABI, eventName: "Launched", args: { token: token as `0x${string}`, tokenId: BigInt(logIndex + 1), launcher: LAUNCHER } }),
    data: encodeAbiParameters(event.inputs.filter((x) => !x.indexed), [ZERO, POOL, 0, 0, 1000n, metadataURI]),
    blockNumber: 100n, blockHash: HASH, transactionHash: HASH, transactionIndex: 0, logIndex, removed: false,
  };
}

async function fixture(t: { after: (fn: () => void) => void }) {
  resetMock();
  const previous = { factory: process.env.NEXT_PUBLIC_LAUNCH_FACTORY, locker: process.env.NEXT_PUBLIC_LAUNCH_LOCKER, deploy: process.env.LAUNCH_DEPLOY_BLOCK };
  process.env.NEXT_PUBLIC_LAUNCH_FACTORY = FACTORY;
  process.env.NEXT_PUBLIC_LAUNCH_LOCKER = "0x4444444444444444444444444444444444444444";
  process.env.LAUNCH_DEPLOY_BLOCK = "100";
  const db = maybeDb() as { json?: (value: unknown) => unknown };
  const previousJson = db.json;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("external fetch disabled in indexer test"); };
  db.json = (value) => value;
  t.after(() => {
    for (const [key, value] of [["NEXT_PUBLIC_LAUNCH_FACTORY", previous.factory], ["NEXT_PUBLIC_LAUNCH_LOCKER", previous.locker], ["LAUNCH_DEPLOY_BLOCK", previous.deploy]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (previousJson) db.json = previousJson; else delete db.json;
    globalThis.fetch = previousFetch;
  });
  const rows = new Map<string, Row>();
  const state = { name: "Name", symbol: "SYM", logs: [launched("ipfs://metadata")], cursor: 0n, failReads: false };
  getMock().publicClient = {
    getTransactionReceipt: async () => ({ status: "success", transactionHash: HASH, from: LAUNCHER, to: FACTORY, logs: state.logs }),
    getTransaction: async () => ({ from: LAUNCHER, to: FACTORY }),
    getBlock: async () => ({ timestamp: 1_700_000_000n }),
    getBlockNumber: async () => 102n,
    getLogs: async ({ address }: { address: string | string[] }) => address === FACTORY ? parseEventLogs({ abi: LAUNCH_FACTORY_ABI, eventName: "Launched", logs: state.logs }) : [],
    readContract: async ({ functionName }: { functionName: string }) => {
      if (state.failReads) throw new Error("synthetic RPC failure");
      if (functionName === "recipientsOf") return [];
      if (functionName !== "name" && functionName !== "symbol") throw new Error("unexpected read");
      // A genuine ABI round trip verifies that the upstream decoder keeps NUL.
      return decodeFunctionResult({ abi: ERC20_MIN_ABI, functionName, data: encodeFunctionResult({ abi: ERC20_MIN_ABI, functionName, result: state[functionName] }) });
    },
  };
  getMock().query = async (sql, values) => {
    for (const value of values) if (typeof value === "string" && value.includes("\0")) throw Object.assign(new Error("invalid byte sequence for encoding UTF8: 0x00"), { code: "22021" });
    if (sql.includes("INSERT INTO bb_launches")) {
      const token = String(values[1]);
      if (rows.has(token)) return [];
      rows.set(token, { token, token_id: BigInt(values[2] as bigint), quote: String(values[4]), pool_id: String(values[5]), lp_fee: Number(values[7]), metadata_uri: String(values[9]), name: String(values[10]), symbol: String(values[11]), recipients: [] });
      return [{ token }];
    }
    if (sql.includes("FROM bb_launches")) return [...rows.values()].filter((r) => !sql.includes("name = '?'") || r.name === "?" || r.symbol === "?");
    if (sql.includes("UPDATE bb_launches SET") && sql.includes("name = COALESCE")) {
      const row = rows.get(String(values[4]))!;
      if (values[0] !== null) row.name = String(values[0]);
      if (values[1] !== null) row.symbol = String(values[1]);
    }
    if (sql.includes("SELECT cursor_block")) return [{ cursor_block: state.cursor }];
    if (sql.includes("SET cursor_block =")) state.cursor = BigInt(values[0] as bigint);
    return [];
  };
  const indexer = await import("./indexer");
  return { indexer, state, rows };
}

test("launch receipts retain NUL-bearing launches with PostgreSQL-safe chain text", async (t) => {
  const f = await fixture(t);
  for (const field of ["name", "symbol", "metadataURI"] as const) {
    f.rows.clear(); f.state.name = "Name"; f.state.symbol = "SYM";
    const value = "before\0after";
    if (field !== "metadataURI") f.state[field] = value;
    f.state.logs = [launched(field === "metadataURI" ? value : "ipfs://metadata")];
    const result = await f.indexer.applyLaunchTx("base", HASH);
    assert.equal(result.launches, 1, field);
    assert.equal(f.rows.get(TOKEN)![field === "metadataURI" ? "metadata_uri" : field], "beforeafter", field);
    assert.equal((await f.indexer.applyLaunchTx("base", HASH)).launches, 0, "receipt replay remains idempotent");
  }
});

test("a NUL-bearing launch does not block later launches or the range cursor", async (t) => {
  const f = await fixture(t);
  f.state.name = "bad\0name";
  f.state.logs = [launched("bad\0uri"), launched("ordinary", "0x7777777777777777777777777777777777777777", 1)];
  const result = await f.indexer.pollLaunches("base");
  assert.equal(result.launches, 2);
  assert.equal(f.rows.size, 2, "both events are retained, not caught and skipped");
  assert.equal(f.state.cursor, 100n);
  assert.equal((await f.indexer.pollLaunches("base")).launches, 0);
});

test("healing failed token reads removes NUL and preserves existing text limits", async (t) => {
  const f = await fixture(t);
  f.state.failReads = true;
  await f.indexer.applyLaunchTx("base", HASH);
  assert.equal(f.rows.get(TOKEN)!.name, "?");
  f.state.failReads = false;
  f.state.name = "é\0" + "n".repeat(80);
  f.state.symbol = "Σ\0" + "s".repeat(25);
  assert.equal(await f.indexer.healLaunchReads("base"), 1);
  assert.equal(f.rows.get(TOKEN)!.name, "é" + "n".repeat(63));
  assert.equal(f.rows.get(TOKEN)!.symbol, "Σ" + "s".repeat(15));
  assert.equal(await f.indexer.healLaunchReads("base"), 0);
});
