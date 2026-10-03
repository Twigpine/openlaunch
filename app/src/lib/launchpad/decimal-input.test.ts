import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCustomMcapInput, resolveFirstBuyInput, sanitizeDecimalInput } from "./decimal-input.ts";

test("plain decimals pass through", () => {
  assert.equal(sanitizeDecimalInput(""), "");
  assert.equal(sanitizeDecimalInput("0"), "0");
  assert.equal(sanitizeDecimalInput("1.5"), "1.5");
  assert.equal(sanitizeDecimalInput(".5"), ".5");
  assert.equal(sanitizeDecimalInput("007"), "007");
});

test("scientific notation is rejected, never corrupted into a tradable size", () => {
  assert.equal(sanitizeDecimalInput("1e-7"), "", "must not become 17 (~1e8x the intent)");
  assert.equal(sanitizeDecimalInput("1E21"), "", "must not become 121");
  assert.equal(sanitizeDecimalInput("2.5e3"), "");
  assert.equal(sanitizeDecimalInput("e"), "");
  assert.equal(sanitizeDecimalInput("1 e-7"), "", "a space before the exponent must not make it 17");
  assert.equal(sanitizeDecimalInput("1,000e3"), "", "grouping before the exponent too");
  assert.equal(sanitizeDecimalInput("1e"), "", "an exponent being typed is rejected, not silently dropped");
});

test("grouping, currency and whitespace are stripped; only the first dot survives", () => {
  assert.equal(sanitizeDecimalInput("1,234.5"), "1234.5");
  assert.equal(sanitizeDecimalInput(" 3.5 "), "3.5");
  assert.equal(sanitizeDecimalInput("$12.25"), "12.25");
  assert.equal(sanitizeDecimalInput("1,234,567.89"), "1234567.89");
  assert.equal(sanitizeDecimalInput("abc1.5"), "1.5");
  assert.equal(sanitizeDecimalInput("12 USD"), "12");
  // "ETH" carries an E: a unit after a space is not an exponent, so the amount survives
  assert.equal(sanitizeDecimalInput("0.5 ETH"), "0.5");
  assert.equal(sanitizeDecimalInput("1.5eth"), "1.5", "a unit word right after the number is not an exponent");
  assert.equal(sanitizeDecimalInput("1.e5"), "", "an exponent right after the dot is still rejected");
});

test("resolveCustomMcapInput clears the preset pick when the entry sanitizes to empty", () => {
  assert.deepEqual(resolveCustomMcapInput("1e-7"), { value: "", clearPick: true }, "rejected entry must not fall back to the old preset cap");
  assert.deepEqual(resolveCustomMcapInput("25000"), { value: "25000", clearPick: false });
  assert.deepEqual(resolveCustomMcapInput(""), { value: "", clearPick: false }, "clearing the field is not a rejection");
  assert.deepEqual(resolveCustomMcapInput("   "), { value: "", clearPick: false });
});

test("resolveFirstBuyInput: a rejected entry keeps the shown amount; only clearing declines", () => {
  assert.deepEqual(resolveFirstBuyInput("0.05"), { kind: "choose", value: "0.05" });
  assert.deepEqual(resolveFirstBuyInput("0.5 ETH"), { kind: "choose", value: "0.5" });
  assert.deepEqual(resolveFirstBuyInput("1e-7"), { kind: "ignore" }, "never launch without the buy because a paste was rejected");
  assert.deepEqual(resolveFirstBuyInput("1 e-7"), { kind: "ignore" });
  assert.deepEqual(resolveFirstBuyInput(""), { kind: "decline" });
  assert.deepEqual(resolveFirstBuyInput("  "), { kind: "decline" });
});

test("ambiguous separators are rejected, never rewritten into a different valid amount", () => {
  // more than one dot: dropping the extras once turned a de-DE million into 1 (a $1 launch cap)
  assert.equal(sanitizeDecimalInput("1.000.000"), "");
  assert.equal(sanitizeDecimalInput("1.234.567"), "");
  assert.equal(sanitizeDecimalInput("1..2"), "");
  assert.equal(sanitizeDecimalInput("1.2.3"), "");
  // a decimal comma: stripping it made 0,05 into 5 (100x) and 1,5 into 15
  assert.equal(sanitizeDecimalInput("0,05"), "");
  assert.equal(sanitizeDecimalInput("1,5"), "");
  assert.equal(sanitizeDecimalInput("1.000,50"), "");
  assert.equal(sanitizeDecimalInput("1,0000"), "", "grouping is exactly three digits");
  assert.equal(sanitizeDecimalInput("12,"), "", "a trailing comma is not grouping either");
  // well-formed grouping only: a 1-3 digit lead (not 0), then groups of exactly three, none after the dot
  assert.equal(sanitizeDecimalInput("0,123"), "", "a decimal comma with three decimals, not 123 (1,000x)");
  assert.equal(sanitizeDecimalInput("1234,567"), "", "a four-digit lead is not grouping");
  assert.equal(sanitizeDecimalInput("01,234"), "");
  assert.equal(sanitizeDecimalInput(",500"), "");
  assert.equal(sanitizeDecimalInput("1,234.567,000"), "", "no comma after the decimal point");
  assert.equal(sanitizeDecimalInput("1,23,456"), "", "every group after the lead is exactly three digits");
  // real grouping still reads
  assert.equal(sanitizeDecimalInput("12,000"), "12000");
  assert.equal(sanitizeDecimalInput("1,234,567"), "1234567");
  assert.equal(sanitizeDecimalInput("$1,234.50 USD"), "1234.50");
  assert.equal(sanitizeDecimalInput("999,999.99"), "999999.99");
  assert.equal(sanitizeDecimalInput("100000"), "100000", "ungrouped numbers are untouched");
});

test("the launch form's rejected entries stay visible states, not a different cap or buy", () => {
  assert.deepEqual(resolveCustomMcapInput("1.000.000"), { value: "", clearPick: true });
  assert.deepEqual(resolveFirstBuyInput("0,05"), { kind: "ignore" });
});
