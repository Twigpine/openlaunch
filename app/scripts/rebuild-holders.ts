/**
 * From app/, with the same NEXT_PUBLIC_LAUNCH_FACTORY* and NEXT_PUBLIC_LAUNCH_LOCKER* configuration as the site:
 *   npx tsx scripts/rebuild-holders.ts > rebuild-holders.generated.sql
 * Review the generated SQL, then run it with psql -v ON_ERROR_STOP=1 on the intended database.
 * This command writes SQL to stdout only. It never connects to a database or reads private credentials.
 */
import { readFileSync } from "node:fs";
import { holderExclusionsByChain, holderRebuildSql } from "../src/lib/launchpad/holder-system-addresses";

try {
  const sql = readFileSync(new URL("./rebuild-holders.sql", import.meta.url), "utf8");
  process.stdout.write(holderRebuildSql(sql, holderExclusionsByChain()));
} catch (error) {
  console.error(error instanceof Error ? error.message : "could not generate holder rebuild SQL");
  process.exitCode = 1;
}
