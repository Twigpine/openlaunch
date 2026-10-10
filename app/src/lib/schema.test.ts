import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Static contract between db/schema.sql and the SQL templates in src/ + scripts/:
 *   - the schema is Postgres-only (no Supabase roles / RLS / auth.*) and every
 *     CREATE is idempotent (it is re-applied on every Fly deploy);
 *   - every bb_* table / function referenced from code exists;
 *   - every column named in `insert into bb_x (…)`, `update bb_x set …` and in
 *     plain `select a, b from bb_x` lists exists on that table.
 * Catches the "renamed a column in the schema, forgot a route" class of bug
 * without a database.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");
const schema = readFileSync(path.join(ROOT, "db/schema.sql"), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(p) && !/\.test\.ts$/.test(p)) out.push(p);
  }
  return out;
}
const sources = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))].map((p) => ({ file: path.relative(ROOT, p), text: readFileSync(p, "utf8") }));

// ── parse the schema ─────────────────────────────────────────────────────────
const tables = new Map<string, Set<string>>();
for (const m of schema.matchAll(/CREATE TABLE IF NOT EXISTS (bb_\w+) \(([\s\S]*?)\n\);/g)) {
  const cols = new Set<string>();
  for (const line of m[2].split("\n")) {
    const col = /^\s*([a-z_]\w*)\s+(?:text|bigint|bigserial|integer|int|numeric|boolean|timestamptz|date|uuid|jsonb|text\[\])\b/.exec(line);
    if (col && !/^(CHECK|UNIQUE|PRIMARY)$/i.test(col[1])) cols.add(col[1]);
  }
  tables.set(m[1], cols);
}
for (const m of schema.matchAll(/ALTER TABLE (bb_\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)) tables.get(m[1])?.add(m[2]);
const functions = new Set([...schema.matchAll(/CREATE OR REPLACE FUNCTION (bb_\w+)/g)].map((m) => m[1]));
// bb_board() returns a TABLE; selects over it use `*`, so no column list to check.

test("schema.sql is Postgres-only and idempotent", () => {
  for (const t of ["bb_migrations", "bb_launches", "bb_launch_swaps", "bb_launch_fee_events", "bb_launch_meta", "bb_launch_sync_state"]) assert.ok(tables.has(t), `missing table ${t}`);
  const l = tables.get("bb_launches")!;
  for (const c of ["token", "token_id", "pool_id", "start_tick", "lp_fee", "supply", "sqrt_price_x96", "volume_quote", "fees_quote_burned", "recipients"]) assert.ok(l.has(c), `bb_launches.${c}`);
  // no PII anywhere: addresses and tx hashes only
  for (const [t, cols] of tables) for (const c of cols) assert.doesNotMatch(c, /\b(ip|ip_address|user_agent|ua|email)\b/, `${t}.${c} looks like PII`);
  assert.doesNotMatch(schema, /ROW LEVEL SECURITY|\banon\b|\bauthenticated\b|service_role|\bauth\.|SECURITY DEFINER|^\s*(GRANT|REVOKE)\b/im);
  for (const m of schema.matchAll(/^\s*CREATE\s+(?!TABLE IF NOT EXISTS|INDEX IF NOT EXISTS|UNIQUE INDEX IF NOT EXISTS|OR REPLACE FUNCTION)(\w+[^\n]*)/gim)) {
    assert.fail(`non-idempotent CREATE: ${m[0].trim()}`);
  }
  for (const m of schema.matchAll(/^\s*ALTER TABLE \w+ ADD COLUMN (?!IF NOT EXISTS)/gim)) assert.fail(`non-idempotent ALTER: ${m[0].trim()}`);
});

function stripTemplates(s: string): string {
  // remove ${…} placeholders (nested one level for inner template literals) so values never look like columns
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(/\$\{[^{}]*\}/g, "?");
  }
  return s;
}
function cols(list: string): string[] {
  return list
    .split(",")
    .map((c) => c.trim().replace(/^\w+\./, "").replace(/\s+as\s+\w+$/i, ""))
    .filter((c) => /^[a-z_]\w*$/i.test(c) && !/^(now|true|false|null)$/i.test(c));
}

test("every bb_* table/function referenced from src/ and scripts/ exists in db/schema.sql", () => {
  const known = new Set([...tables.keys(), ...functions]);
  for (const { file, text } of sources) {
    for (const m of stripTemplates(text).matchAll(/\b(?:from|into|update|join)\s+(bb_\w+)\b(?!\s*\()/gi)) {
      assert.ok(tables.has(m[1]), `${file}: unknown table ${m[1]}`);
    }
    for (const m of text.matchAll(/\b(bb_\w+)\(/g)) {
      assert.ok(functions.has(m[1]), `${file}: unknown function ${m[1]}()`);
    }
    for (const m of text.matchAll(/["'`](bb_\w+)["'`]/g)) {
      if (!known.has(m[1]) && tables.has(m[1].replace(/_\w+_(key|idx)$/, ""))) continue; // index/constraint names
      assert.ok(known.has(m[1]) || /_(key|idx)$/.test(m[1]), `${file}: quoted unknown object ${m[1]}`);
    }
  }
});

test("insert / update / select column lists match the schema", () => {
  let checked = 0;
  for (const { file, text } of sources) {
    const sqlish = stripTemplates(text);
    for (const m of sqlish.matchAll(/insert into (bb_\w+)\s*\(([^)]*)\)/gi)) {
      const t = tables.get(m[1])!;
      for (const c of cols(m[2])) {
        assert.ok(t.has(c), `${file}: ${m[1]} has no column ${c} (insert)`);
        checked++;
      }
    }
    for (const m of sqlish.matchAll(/update (bb_\w+)\s+set\s+([\s\S]*?)\s+(?:where|returning)\b/gi)) {
      const t = tables.get(m[1])!;
      for (const c of m[2].matchAll(/(?:^|,)\s*(\w+)\s*=/g)) {
        assert.ok(t.has(c[1]), `${file}: ${m[1]} has no column ${c[1]} (update)`);
        checked++;
      }
    }
    // joined selects (… from bb_x s join …) mix columns of several tables — skipped here, covered by the app's typed row types
    for (const m of sqlish.matchAll(/select\s+([\w\s,.]+?)\s+from\s+(bb_\w+)\b(?!\s*\()(?![^;`]{0,80}\bjoin\b)/gi)) {
      const t = tables.get(m[2]);
      assert.ok(t, `${file}: select from unknown table ${m[2]}`);
      for (const c of cols(m[1])) {
        assert.ok(t.has(c), `${file}: ${m[2]} has no column ${c} (select)`);
        checked++;
      }
    }
    for (const m of sqlish.matchAll(/on conflict \(([^)]*)\)/gi)) {
      // the conflict target must be a real column set of the table named just before it
      const inserts = [...sqlish.slice(0, m.index).matchAll(/insert into (bb_\w+)/gi)];
      const last = inserts[inserts.length - 1];
      const t = last && tables.get(last[1]);
      if (t) for (const c of cols(m[1])) assert.ok(t.has(c), `${file}: ${last![1]} has no column ${c} (on conflict)`);
    }
  }
  assert.ok(checked > 80, `expected to check many columns, checked ${checked}`);
});

test("db/concurrent-indexes.sql: only idempotent CONCURRENTLY index builds, on tables and columns schema.sql has", () => {
  const text = readFileSync(path.join(ROOT, "db/concurrent-indexes.sql"), "utf8").replace(/--[^\n]*/g, "");
  const stmts = text.split(";").map((s) => s.trim()).filter(Boolean);
  assert.ok(stmts.length > 0);
  for (const s of stmts) {
    const m = /^CREATE INDEX CONCURRENTLY IF NOT EXISTS (\w+) ON (bb_\w+) \(([^)]*)\)/i.exec(s);
    assert.ok(m, `not an idempotent concurrent index build: ${s.slice(0, 80)}`);
    const cols = tables.get(m[2]);
    assert.ok(cols, `unknown table ${m[2]}`);
    for (const c of m[3].split(",").map((x) => x.trim().split(/\s+/)[0])) assert.ok(cols.has(c), `${m[2]}.${c} is not in schema.sql`);
    assert.doesNotMatch(schema, new RegExp(`INDEX IF NOT EXISTS ${m[1]}\\b`), `${m[1]} is also built inside the schema transaction`);
  }
});
