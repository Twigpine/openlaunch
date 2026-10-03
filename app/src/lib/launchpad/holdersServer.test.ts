import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as holders from "./holders.ts";

const source = readFileSync(new URL("./holdersServer.ts", import.meta.url), "utf8");

test("the shared completion marker preserves already-indexed rows and the writer's persisted format", () => {
  assert.equal(holders.SYNCED_FOREVER, 9223372036854775807n);
  const indexer = readFileSync(new URL("./indexer.ts", import.meta.url), "utf8");
  assert.match(indexer, /import \{[^}]*SYNCED_FOREVER[^}]*\} from "\.\/holders"/);
  assert.match(indexer, /const mark = to >= cursor \? SYNCED_FOREVER : to/);
});

test("holder panels become synced only at the indexer's exact completion sentinel", async () => {
  for (const mark of [null, 1_000_010n, 2_000_011n, 9223372036854775806n, 9223372036854775807n]) {
    const row = { launcher: `0x${"ab".repeat(20)}`, supply: "1000000000000000000000000000", block_number: 10n, holders: 7, holders_synced_block: mark };
    const db = async (parts: TemplateStringsArray) => parts.join("").includes("FROM bb_launches") ? [row] : [];
    const imports: Record<string, unknown> = {
      "server-only": {},
      "@/lib/db": { maybeDb: () => db },
      "@/lib/chainPublic": { chainIdOf: () => 8453 },
      "./holders": holders,
      "./indexer": { systemAddresses: () => [] },
    };
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const api = {} as { getHolderPanel: (chain: string, token: string) => Promise<{ synced: boolean; holders: number }> };
    new Function("require", "exports", output)((id: string) => {
      assert.ok(Object.hasOwn(imports, id), `unexpected import: ${id}`);
      return imports[id];
    }, api);
    const panel = await api.getHolderPanel("base", row.launcher);
    assert.equal(panel.synced, mark === 9223372036854775807n, `progress ${mark} must not look complete`);
    assert.equal(panel.holders, 7, "the partial count is retained but explicitly marked unsynced");
  }
});
