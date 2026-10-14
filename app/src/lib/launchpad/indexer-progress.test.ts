import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/** Execute the production functions with deterministic database and RPC responses. */
function productionFunction(file: string, name: string, bindings: Record<string, unknown>) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Missing ${name} in ${file}`);
  const { outputText } = ts.transpileModule(`(${declaration.getText(ast).replace(/^export /, "")})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return runInNewContext(outputText, bindings);
}

for (const failure of ["head", "lp-v1", "quote-v2"]) {
  test(`a failed ${failure} read cannot finalize a season before a new suite backfills`, async () => {
    const suites = [
      { id: "lp-v1", factory: "legacy-factory", locker: "legacy-locker", feeContract: "legacy-locker", deployBlock: 1n },
      { id: "quote-v2", factory: "quote-factory", deployBlock: 100n },
    ];
    let chainCursor = 2000n;
    let knownHead = 1900n;
    let lastError: string | null = null;
    let failingRead: string | null = failure;
    const cursors = new Map<string, bigint>();
    const ranges: { suite: string; from: bigint }[] = [];
    const read = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("INSERT INTO bb_launch_suite_cursor")) {
        const key = `${values[1]}:${values[2]}`;
        if (!cursors.has(key)) cursors.set(key, values[3] as bigint);
      } else if (sql.includes("FROM bb_launch_suite_cursor")) {
        return [{ cursor_block: cursors.get(`${values[1]}:${values[2]}`) }];
      } else if (sql.includes("UPDATE bb_launch_suite_cursor")) {
        cursors.set(`${values[2]}:${values[3]}`, values[0] as bigint);
      } else if (sql.includes("FROM bb_launch_sync_cursor")) {
        return [{ chain_id: 8453, cursor_block: chainCursor }];
      } else if (sql.includes("UPDATE bb_launch_sync_cursor")) {
        if (sql.includes("SET cursor_block")) chainCursor = values[0] as bigint;
        if (sql.includes("head_block = COALESCE")) {
          knownHead = (values[0] as bigint | null) ?? knownHead;
          lastError = values[1] as string;
        } else if (sql.includes("head_block =")) {
          knownHead = values[sql.includes("SET cursor_block") ? 1 : 0] as bigint;
        }
        if (sql.includes("last_error = NULL")) lastError = null;
      }
      return [];
    };
    const client = {
      getBlockNumber: async () => {
        if (failingRead === "head") throw new Error("head unavailable");
        return 2002n;
      },
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber }),
    };
    const run = productionFunction("./indexer.ts", "run", {
      skipReason: () => null, maybeDb: () => read, chainIdOf: () => 8453, launchSuites: () => suites,
      publicClient: () => client, confirmations: () => 2n, syncOverlapBlocks: () => 10n,
      SYNC_CHUNK_BLOCKS: 1000n, SYNC_MAX_CHUNKS_PER_CALL: 10,
      errMessage: (error: Error) => error.message, redactUrls: (message: string) => message,
      applyRange: async (_db: unknown, _chain: string, from: bigint, _to: bigint, suite: { id: string }) => {
        ranges.push({ suite: suite.id, from });
        if (failingRead === suite.id) throw new Error(`${suite.id} range unavailable`);
        return { launches: 0, swaps: 0, fees: 0 };
      },
    });
    const indexedThrough = productionFunction("../points/server.ts", "indexedThrough", {
      indexedChains: () => ["base"], chainIdOf: () => 8453, publicClient: () => client,
    });
    const computeSeason = productionFunction("../points/server.ts", "computeSeason", { indexedThrough });

    await assert.rejects(run("base"), /unavailable/);
    assert.equal(chainCursor, 0n);
    assert.equal(cursors.get("lp-v1:legacy-factory"), 2000n, "v1 inherits its old cursor before the aggregate falls");
    assert.equal(cursors.get("quote-v2:quote-factory"), 0n);
    assert.equal(knownHead, failure === "head" ? 1900n : 2002n);
    assert.match(lastError!, /unavailable/);
    assert.equal(await indexedThrough(read), null);
    const season = { starts_at: new Date(100_000).toISOString(), ends_at: new Date(1_500_000).toISOString() };
    const computed = await computeSeason(read, read, season);
    assert.equal(computed.skipped, "waiting for every indexer to read past the season's end");

    // The failed first range stays eligible; a successful retry publishes progress and clears the error.
    failingRead = null;
    const result = await run("base");
    assert.equal(chainCursor, 2000n);
    assert.equal(result.to, "2000");
    assert.equal(result.caught_up, true);
    assert.equal(lastError, null);
    assert.equal(ranges.find((r) => r.suite === "quote-v2")?.from, 100n);
    assert.equal(await indexedThrough(read), 2_000_000);
  });
}
