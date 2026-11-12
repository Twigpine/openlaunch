// Test-only DB adapter. The opted-in suite owns random schemas on a loopback DB.
export { errMessage, uniqueViolation } from "../src/lib/pg";
import type { Db } from "../src/lib/db";
let active: Db | null = null;
export function setDb(value: Db | null) { active = value; }
export function maybeDb() { return active; }
export function db() {
    if (!active)
        throw new Error("reorg test database not configured");
    return active;
}
export function dbConfigured() { return active !== null; }
export type { Db };
