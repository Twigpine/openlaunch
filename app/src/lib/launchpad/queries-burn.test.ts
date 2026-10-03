import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const source = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
const dead = "0x000000000000000000000000000000000000dead";

// Runs the actual predicate in PostgreSQL over in-memory input values. No
// application tables, schema changes or stored fixtures are needed.
test("burn SQL excludes malformed recipient JSON without losing valid burn pools", {
  skip: !databaseUrl && "Set TEST_DATABASE_URL or DATABASE_URL for the read-only SQL regression",
}, async () => {
  const predicate = source.match(/if \(opts\.filter === "burn"\) conds\.push\(db`([^`]+)`\);/)?.[1];
  assert.ok(predicate, "the launch query exposes its burn predicate");
  const cases = [
    { label: "burn", lp_fee: 10000, recipients: [{ payout: dead, bps: 10000 }] },
    { label: "uppercase", lp_fee: 10000, recipients: [{ payout: dead.toUpperCase(), bps: 10000 }] },
    { label: "free", lp_fee: 0, recipients: [{ payout: dead, bps: 10000 }] },
    { label: "split", lp_fee: 10000, recipients: [{ payout: dead, bps: 5000 }, { payout: "0x123", bps: 5000 }] },
    { label: "beneficiary", lp_fee: 10000, recipients: [{ payout: "0x123", bps: 10000 }] },
    ...[null, {}, "[]", JSON.stringify([{ payout: dead, bps: 10000 }]), 1, true, []].map((recipients, i) => ({ label: `malformed-${i}`, lp_fee: 10000, recipients })),
  ];
  const sql = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    const rows = await sql.unsafe<{ label: string }[]>(
      `SELECT l.label FROM jsonb_to_recordset($2::text::jsonb) AS l(label text, lp_fee integer, recipients jsonb) WHERE ${predicate.replace("${DEAD_ADDR}", "$1")} ORDER BY l.label`,
      [dead, JSON.stringify(cases)],
    );
    assert.deepEqual(rows.map((row) => row.label), ["burn", "uppercase"]);
  } finally {
    await sql.end();
  }
});
