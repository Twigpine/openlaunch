import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseAmount } from "@openlaunch/solana-sdk";
import { parseAmount as parseMathAmount } from "@openlaunch/solana-sdk/math";

function appJson(path: string) {
  return JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"));
}

test("the app and its tests resolve both SDK entry points directly to source", () => {
  for (const config of ["tsconfig.json", "tsconfig.test.json"]) {
    const paths = appJson(config).compilerOptions.paths;
    assert.deepEqual(paths["@openlaunch/solana-sdk"], ["./packages/solana-sdk/src/index.ts"]);
    assert.deepEqual(paths["@openlaunch/solana-sdk/math"], ["./packages/solana-sdk/src/math.ts"]);
  }
  assert.equal(parseAmount("1.000001", 6), 1_000_001n);
  assert.equal(parseMathAmount("1.000001", 6), 1_000_001n);
});

test("the app installs SDK dependencies from the registry, without a local package link", () => {
  const app = appJson("package.json");
  const sdk = appJson("packages/solana-sdk/package.json");
  const lock = appJson("package-lock.json");
  assert.equal(app.dependencies["@openlaunch/solana-sdk"], undefined);
  assert.equal(lock.packages["node_modules/@openlaunch/solana-sdk"], undefined);
  assert.equal(lock.packages["packages/solana-sdk"], undefined);
  for (const key of Object.keys(lock.packages)) {
    assert.doesNotMatch(key, /(?:^|\/)node_modules\/(?:bufferutil|utf-8-validate|rpc-websockets|jayson)$/,
      "the migrated client must not reintroduce the legacy native WebSocket dependency chain");
  }
  assert.equal(app.dependencies["@solana/keys"], "8.5.0", "retain strict small-order signature protection");
  for (const [name, version] of Object.entries(sdk.dependencies)) {
    assert.equal(app.dependencies[name], version, `${name} must be installed by the app`);
  }
});

test("the standard app test gate retains SDK and independent-model coverage", () => {
  const { scripts } = appJson("package.json");
  assert.match(scripts.test, /&& npm run test:solana && node scripts\/solana-checks\.mjs --ci$/);
  assert.match(scripts["test:solana"], /tsc --noEmit -p packages\/solana-sdk\/tsconfig\.json/);
  assert.match(scripts["test:solana"], /tsx --test "packages\/solana-sdk\/tests\/\*\.test\.ts"/);
  assert.match(scripts["test:solana"], /node --experimental-strip-types --test "\.\.\/packages\/solana-model\/\*\.test\.mjs"/);
});
