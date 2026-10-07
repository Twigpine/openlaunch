import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SELECT, VOLUME_COLUMN_SQL, VOLUME_WINDOWS } from "./queries.ts";

/**
 * The Volume sort orders by a column per window. The window volumes live on the lateral subquery aliased `w`
 * (v1, v24); an ORDER BY naming an alias the query does not define is a 502 on the home board.
 */
const lateral = SELECT.slice(SELECT.indexOf("LEFT JOIN LATERAL ("), SELECT.lastIndexOf(") w ON"));
const wColumns = new Set([...lateral.matchAll(/\bAS (\w+)/g)].map((m) => m[1]));
// aliases visible to the ORDER BY (the lateral's own inner alias is not): "FROM bb_launches l", "JOIN bb_launch_meta m", "LATERAL (...) w"
const definedAliases = new Set([...SELECT.replace(lateral, "LATERAL (...").matchAll(/\b(?:FROM|JOIN) bb_\w+ (\w+)|\) (\w+) ON/g)].map((m) => m[1] ?? m[2]));

test("the lateral subquery is still aliased w and carries the window volumes", () => {
  assert.ok(SELECT.includes(") w ON true"));
  assert.ok(wColumns.has("v1") && wColumns.has("v24"));
  assert.deepEqual([...definedAliases].sort(), ["l", "m", "w"]);
});

test("every volume window orders by columns the query defines", () => {
  assert.deepEqual(Object.keys(VOLUME_COLUMN_SQL).sort(), [...VOLUME_WINDOWS].sort(), "one column per window");
  for (const win of VOLUME_WINDOWS) {
    const refs = [...VOLUME_COLUMN_SQL[win].matchAll(/\b(\w+)\.(\w+)\b/g)];
    assert.ok(refs.length > 0, win);
    for (const [, alias, column] of refs) {
      assert.ok(definedAliases.has(alias), `${win}: alias ${alias} is not in the query`);
      if (alias === "w") assert.ok(wColumns.has(column), `${win}: w.${column} is not a lateral column`);
    }
  }
});

test("listLaunchesPage ranks by that table, not by aliases of its own", () => {
  const source = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
  assert.match(source, /const volCol = db\.unsafe\(VOLUME_COLUMN_SQL\[win\]\);/);
  // the two aliases the query never defined: the 502 came back the day someone typed them again
  assert.doesNotMatch(source, /\bw1\.v\b|\bw24\.v\b/);
});

