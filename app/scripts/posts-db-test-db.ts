// Explicit integration-test adapter. Never imported by the application build.
import type { Db } from "../src/lib/db.ts";

let connection: Db | null = null;

export function setPostsTestDb(value: Db | null) { connection = value; }
export function maybeDb(): Db | null { return connection; }
export type { Db };
