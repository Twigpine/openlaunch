import assert from "node:assert/strict";
import test from "node:test";
import { isPlainObject, validateArgs, type ObjectSchema } from "./schema.ts";

const schema: ObjectSchema = {
  type: "object",
  properties: {
    sort: { type: "string", description: "sort", enum: ["new", "live"], default: "new" },
    limit: { type: "integer", description: "limit", minimum: 1, maximum: 25, default: 10 },
    token: { type: "string", description: "token", pattern: "^0x[0-9a-fA-F]{40}$" },
    ratio: { type: "number", description: "ratio", minimum: 0, maximum: 1 },
    flag: { type: "boolean", description: "flag" },
  },
  additionalProperties: false,
};

test("validateArgs applies defaults and keeps supplied values", () => {
  const r = validateArgs(schema, { token: "0x" + "a".repeat(40) });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value, { sort: "new", limit: 10, token: "0x" + "a".repeat(40) });
});

test("validateArgs rejects unknown keys, wrong types and out-of-range values", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /must be an object/],
    [[], /must be an object/],
    [{ nope: 1 }, /unknown argument "nope"/],
    [{ limit: "10" }, /must be a number/],
    [{ limit: 1.5 }, /must be an integer/],
    [{ limit: 0 }, /at least 1/],
    [{ limit: 26 }, /at most 25/],
    [{ sort: "hot" }, /must be one of: new, live/],
    [{ token: "0x123" }, /invalid format/],
    [{ ratio: 2 }, /at most 1/],
    [{ flag: "yes" }, /must be a boolean/],
  ];
  for (const [input, expected] of cases) {
    const r = validateArgs(schema, input);
    assert.equal(r.ok, false, JSON.stringify(input));
    if (r.ok) continue;
    assert.match(r.error, expected);
  }
});

test("validateArgs requires properties listed in required", () => {
  const required: ObjectSchema = { ...schema, required: ["token"] };
  const r = validateArgs(required, {});
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /argument "token" is required/);
});

test("isPlainObject rejects arrays, null and class instances", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(new Date()), false);
});
