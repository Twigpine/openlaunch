import { test } from "node:test";
import assert from "node:assert/strict";
import { launchMultiple, marketChange, marketUsd } from "./market-format.ts";

test("ledger money fits its column without rounding dust to zero", () => {
  assert.equal(marketUsd(0), "$0");
  assert.equal(marketUsd(0.0049), "<$0.01");
  assert.equal(marketUsd(0.1486467461), "$0.15");
  assert.equal(marketUsd(25_123), "$25.1K");
  assert.equal(marketUsd(Number.NaN), "—");
});

test("rounded zero changes are neutral; extreme values stay bounded", () => {
  assert.deepEqual(marketChange(0.00000003), { label: "0.0%", direction: "flat" });
  assert.deepEqual(marketChange(-0.00000003), { label: "0.0%", direction: "flat" });
  assert.deepEqual(marketChange(0.014), { label: "+1.4%", direction: "up" });
  assert.deepEqual(marketChange(-0.12), { label: "-12%", direction: "down" });
  assert.ok(marketChange(7.259e18).label.length < 12);
  assert.deepEqual(marketChange(Infinity), { label: "—", direction: "flat" });
});

test("non-finite changes and finite values that overflow percentages are neutral", () => {
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    assert.deepEqual(marketChange(value), { label: "—", direction: "flat" }, String(value));
  }
  assert.deepEqual(marketChange(0), { label: "0.0%", direction: "flat" });
  assert.deepEqual(marketChange(-0), { label: "0.0%", direction: "flat" });
  assert.deepEqual(marketChange(1e300), { label: "1.0e+300×", direction: "up" });
  assert.deepEqual(marketChange(-1e300), { label: "-1.0e+302%", direction: "down" });
});

test("rises of 100% or more read as a multiple of the launch price; smaller moves and falls stay percentages", () => {
  assert.deepEqual(marketChange(0.99), { label: "+99%", direction: "up" });
  assert.deepEqual(marketChange(1), { label: "2.0×", direction: "up" });
  assert.deepEqual(marketChange(18.7), { label: "19.7×", direction: "up" });
  assert.deepEqual(marketChange(244), { label: "245×", direction: "up" });
  assert.deepEqual(marketChange(1233), { label: "1.2K×", direction: "up" });
  assert.deepEqual(marketChange(-0.5), { label: "-50%", direction: "down" });
  assert.equal(launchMultiple(0.5), null);
  assert.equal(launchMultiple(-0.9), null);
  assert.equal(launchMultiple(Number.NaN), null);
});
