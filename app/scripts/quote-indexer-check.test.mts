/** Run only against a disposable local PostgreSQL server; each case creates and removes its own database. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import postgres from "postgres";

const run=promisify(execFile);
const configured=process.env.QUOTE_TEST_DATABASE_URL;
if (!configured || new URL(configured).hostname !== "127.0.0.1") throw new Error("Set QUOTE_TEST_DATABASE_URL to a disposable PostgreSQL server on 127.0.0.1");
const appDir=fileURLToPath(new URL("../",import.meta.url));
const script=fileURLToPath(new URL("quote-indexer-check.mts",import.meta.url));
const cases=[
  {name:"fresh database runs the complete integration check",setup:"",read:null},
  {name:"existing launch data is rejected before migrations",setup:"CREATE TABLE bb_launches (token text, lp_fee integer); INSERT INTO bb_launches VALUES ('keep', 10000)",read:"SELECT * FROM bb_launches"},
  {name:"unrelated public data without launches is untouched",setup:"CREATE TABLE customer_notes (note text); INSERT INTO customer_notes VALUES ('keep')",read:"SELECT * FROM customer_notes"},
  {name:"data outside the public schema is untouched",setup:'CREATE SCHEMA "other app"; CREATE TABLE "other app".notes (note text); INSERT INTO "other app".notes VALUES (\'keep\')',read:'SELECT * FROM "other app".notes'},
  {name:"an existing empty table is rejected",setup:"CREATE TABLE empty_table (id integer)",read:"SELECT * FROM empty_table"},
  {name:"an existing view is rejected",setup:"CREATE VIEW existing_view AS SELECT 'keep'::text AS note",read:"SELECT * FROM existing_view"},
  {name:"an existing sequence is not advanced",setup:"CREATE SEQUENCE existing_sequence START 42",read:"SELECT last_value, is_called FROM existing_sequence"},
];

for (const scenario of cases) test(scenario.name, {timeout:30_000}, async()=>{
  const admin=postgres(configured,{max:1,onnotice:()=>{}});
  const name=`quote_precheck_${randomUUID().replaceAll("-","")}`;
  let created=false;
  let db: ReturnType<typeof postgres> | undefined;
  try {
    await admin`CREATE DATABASE ${admin(name)}`;
    created=true;
    const url=new URL(configured);
    url.pathname=`/${name}`;
    db=postgres(url.toString(),{max:1,onnotice:()=>{}});
    if (scenario.setup) await db.unsafe(scenario.setup);
    // Capture relation identities and column definitions as well as the sentinel rows. No migration may run.
    const snapshot=async()=>JSON.stringify({
      relations:await db!`SELECT n.nspname,c.relname,c.relkind,c.oid,a.attnum,a.attname,a.atttypid,a.attnotnull
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        ORDER BY n.nspname,c.relname,a.attnum`,
      data:scenario.read ? await db!.unsafe(scenario.read) : [],
    });
    const before=await snapshot();
    const execute=()=>run(process.execPath,["--conditions=react-server","--import","tsx",script],{
      cwd:appDir,env:{...process.env,QUOTE_TEST_DATABASE_URL:url.toString()},timeout:20_000,
    });
    if (scenario.setup) {
      await assert.rejects(execute(),(error: unknown)=>{
        const failure=error as {code?:number;stderr?:string};
        assert.equal(failure.code,1);
        assert.match(failure.stderr ?? "",/use an empty test database with no existing user tables, views or sequences/);
        return true;
      });
      assert.equal(await snapshot(),before,"schema and existing records must remain unchanged");
    } else {
      assert.match((await execute()).stdout,/quote indexer: .*passed/);
    }
  } finally {
    await db?.end();
    try { if (created) await admin`DROP DATABASE ${admin(name)}`; }
    finally { await admin.end(); }
  }
});
