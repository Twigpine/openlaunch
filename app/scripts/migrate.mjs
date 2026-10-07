#!/usr/bin/env node
/**
 * Apply db/schema.sql to DATABASE_URL inside ONE transaction. The file is
 * idempotent (IF NOT EXISTS / CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS), so
 * this runs on every deploy as the Fly release_command (fly.toml) and locally
 * after `docker run … postgres:16`. Records one bb_migrations row whenever the
 * sha256 of the file differs from the last applied one.
 *
 * The whole file is sent as a single simple-protocol query (`sql.unsafe` with
 * no parameters) — Postgres splits the statements itself, so `$$ … $$` function
 * bodies never need client-side parsing. Any error rolls everything back and
 * exits 1 (Fly then aborts the deploy).
 *
 *   DATABASE_URL=postgres://… node scripts/migrate.mjs
 *
 * Only depends on `postgres` + node builtins so it runs from the standalone
 * image (Dockerfile copies db/ + this file; next.config.ts keeps `postgres`
 * external so it is traced into .next/standalone/node_modules).
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// Fresh checkouts: pick DATABASE_URL up from .env.local / .env (never overriding a real env var).
if (!process.env.DATABASE_URL) {
  const { readFileSync, existsSync } = await import("node:fs");
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^\s*DATABASE_URL\s*=\s*"?([^"\n#]+)"?/m);
    if (m) {
      process.env.DATABASE_URL = m[1].trim();
      break;
    }
  }
}
const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("migrate: DATABASE_URL is not set");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.BASEBID_SCHEMA_FILE || path.resolve(here, "../db/schema.sql");
const text = await readFile(file, "utf8");
const hash = createHash("sha256").update(text).digest("hex");
const appliedBy = process.env.FLY_IMAGE_REF || process.env.FLY_MACHINE_ID || hostname();

const sql = postgres(url, { max: 1, connect_timeout: 15, idle_timeout: 5, onnotice: () => {} });
const t0 = Date.now();
let exitCode = 0;
try {
  const { changed, history, tables } = await sql.begin(async (tx) => {
    // an ALTER TABLE takes an exclusive lock even when the column exists: never queue behind a long read (and block
    // every read behind us) for more than a few seconds; a failed release just fails the deploy, which can be retried
    await tx`SET LOCAL lock_timeout = '10s'`;
    await tx.unsafe(text);
    const [last] = await tx`select schema_sha256 from bb_migrations order by id desc limit 1`;
    const changed = last?.schema_sha256 !== hash;
    if (changed) {
      await tx`insert into bb_migrations (schema_sha256, applied_by) values (${hash}, ${appliedBy})`;
    }
    const [{ history }] = await tx`select count(*)::int as history from bb_migrations`;
    const [{ tables }] = await tx`
      select count(*)::int as tables from information_schema.tables
       where table_schema = current_schema() and table_name like 'bb\\_%'`;
    return { changed, history, tables };
  });
  console.log(
    `migrate: ok schema=${hash.slice(0, 12)} ${changed ? "applied (new hash)" : "re-applied (unchanged)"} ` +
      `tables=${tables} history=${history} ${Date.now() - t0}ms`,
  );
} catch (err) {
  const e = /** @type {{ message?: string; position?: string; code?: string }} */ (err);
  console.error(`migrate: FAILED ${e?.code ?? ""} ${e?.message ?? err}${e?.position ? ` (at char ${e.position})` : ""}`);
  exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
process.exit(exitCode);
