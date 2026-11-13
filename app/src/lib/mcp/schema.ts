/**
 * A very small JSON Schema subset for MCP tool inputs, plus a validator.
 *
 * The tools are read-only and take scalars, so the whole surface is: an object
 * with typed properties, enums, bounds and a string pattern. Unknown keys are
 * rejected: a typo in a tool call should fail loudly instead of silently
 * returning the default list. Defaults are applied by the validator, so a
 * tool's `run` always sees the same shape.
 *
 * No dependency: the schemas are also served to clients in `tools/list`, and
 * `schema.test.ts` keeps the validator and the advertised schemas honest.
 */

export type PropertySchema =
  | {
      type: "string";
      description: string;
      enum?: readonly string[];
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      default?: string;
    }
  | {
      type: "integer";
      description: string;
      enum?: readonly number[];
      minimum?: number;
      maximum?: number;
      default?: number;
    }
  | {
      type: "number";
      description: string;
      enum?: readonly number[];
      minimum?: number;
      maximum?: number;
      default?: number;
    }
  | { type: "boolean"; description: string; default?: boolean };

export type ObjectSchema = {
  type: "object";
  properties: Record<string, PropertySchema>;
  required?: readonly string[];
  additionalProperties?: false;
};

export type Validation = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** A plain object (not an array, not null, not a class instance). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(path: string, expected: string): Validation {
  return { ok: false, error: `${path} ${expected}` };
}

function property(name: string, schema: PropertySchema, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const path = `argument "${name}"`;
  if (schema.type === "string") {
    if (typeof raw !== "string") return { ok: false, error: `${path} must be a string` };
    if (schema.enum && !schema.enum.includes(raw)) return { ok: false, error: `${path} must be one of: ${schema.enum.join(", ")}` };
    if (schema.minLength !== undefined && raw.length < schema.minLength) return { ok: false, error: `${path} must be at least ${schema.minLength} characters` };
    if (schema.maxLength !== undefined && raw.length > schema.maxLength) return { ok: false, error: `${path} must be at most ${schema.maxLength} characters` };
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(raw)) return { ok: false, error: `${path} has an invalid format` };
    return { ok: true, value: raw };
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false, error: `${path} must be a number` };
    if (schema.type === "integer" && !Number.isInteger(raw)) return { ok: false, error: `${path} must be an integer` };
    if (schema.enum && !schema.enum.includes(raw)) return { ok: false, error: `${path} must be one of: ${schema.enum.join(", ")}` };
    if (schema.minimum !== undefined && raw < schema.minimum) return { ok: false, error: `${path} must be at least ${schema.minimum}` };
    if (schema.maximum !== undefined && raw > schema.maximum) return { ok: false, error: `${path} must be at most ${schema.maximum}` };
    return { ok: true, value: raw };
  }
  if (typeof raw !== "boolean") return { ok: false, error: `${path} must be a boolean` };
  return { ok: true, value: raw };
}

/**
 * Validate `input` against an object schema, applying defaults. Required
 * properties have to be present; optional ones may be omitted. A value of
 * `undefined` counts as omitted (JSON never carries it, but a direct caller
 * can).
 */
export function validateArgs(schema: ObjectSchema, input: unknown): Validation {
  if (!isPlainObject(input)) return fail("arguments", "must be an object");
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(schema.properties, key)) return { ok: false, error: `unknown argument "${key}"` };
    }
  }
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    const raw = input[name];
    if (raw === undefined) {
      if (schema.required?.includes(name)) return { ok: false, error: `argument "${name}" is required` };
      if (prop.default !== undefined) out[name] = prop.default;
      continue;
    }
    const checked = property(name, prop, raw);
    if (!checked.ok) return { ok: false, error: checked.error };
    out[name] = checked.value;
  }
  return { ok: true, value: out };
}
