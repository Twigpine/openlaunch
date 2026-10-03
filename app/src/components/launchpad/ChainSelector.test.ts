import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./ChainSelector.tsx", import.meta.url), "utf8");

test("browsing chain options follow configured visibility, including Arc when live", () => {
  assert.match(source, /import \{ VISIBLE_CHAINS \} from "@\/lib\/launchpad\/config"/);
  assert.match(source, /\[null, \.\.\.VISIBLE_CHAINS\]\.map/);
  assert.match(source, /CHAIN_SHORT\[chain\]/);
  assert.doesNotMatch(source, /\[null, "base", "robinhood"\]/);
});
