import type {
  JsonSchema,
  OutputSchema,
  StandardSchema,
  Validator,
} from "./types.js";
import { LLMConfigurationError, LLMValidationError } from "./errors.js";
const keywords = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);
/** Small explicit JSON Schema subset. Unsupported assertions fail closed. Use a custom validator for full drafts. */
export function checkSchema(schema: JsonSchema): void {
  if (typeof schema === "boolean") return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new LLMConfigurationError("JSON Schema must be an object or boolean");
  for (const key of Object.keys(schema))
    if (!keywords.has(key))
      throw new LLMConfigurationError(
        `Unsupported JSON Schema keyword: ${key}; use a custom validator`,
      );
  if (
    schema.type !== undefined &&
    !(Array.isArray(schema.type) ? schema.type : [schema.type]).every((t) =>
      [
        "null",
        "object",
        "array",
        "string",
        "number",
        "integer",
        "boolean",
      ].includes(String(t)),
    )
  )
    throw new LLMConfigurationError("Invalid schema type");
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      !schema.required.every((k) => typeof k === "string"))
  )
    throw new LLMConfigurationError("required must be an array of strings");
  if (
    schema.properties !== undefined &&
    (!schema.properties ||
      typeof schema.properties !== "object" ||
      Array.isArray(schema.properties))
  )
    throw new LLMConfigurationError("properties must be an object");
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || !schema.enum.length)
  )
    throw new LLMConfigurationError("enum must be a nonempty array");
  for (const key of [
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
  ])
    if (
      schema[key] !== undefined &&
      (typeof schema[key] !== "number" ||
        !Number.isFinite(schema[key]) ||
        (["minLength", "maxLength", "minItems", "maxItems"].includes(key) &&
          (!Number.isInteger(schema[key]) || (schema[key] as number) < 0)))
    )
      throw new LLMConfigurationError(`Invalid schema ${key}`);
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean" &&
    (!schema.additionalProperties ||
      typeof schema.additionalProperties !== "object" ||
      Array.isArray(schema.additionalProperties))
  )
    throw new LLMConfigurationError("Invalid additionalProperties");
  if (schema.properties)
    for (const child of Object.values(schema.properties as object))
      checkSchema(child as JsonSchema);
  if (schema.items !== undefined) checkSchema(schema.items as JsonSchema);
  if (typeof schema.additionalProperties === "object")
    checkSchema(schema.additionalProperties as JsonSchema);
  for (const key of ["anyOf", "oneOf", "allOf"])
    if (schema[key]) {
      if (!Array.isArray(schema[key]))
        throw new LLMConfigurationError(`Invalid ${key}`);
      for (const child of schema[key] as JsonSchema[]) checkSchema(child);
    }
}
function valid(schema: JsonSchema, value: unknown): boolean {
  if (typeof schema === "boolean") return schema;
  const s = schema;
  if (s.type !== undefined) {
    const matches = (t: unknown) =>
      t === "null"
        ? value === null
        : t === "array"
          ? Array.isArray(value)
          : t === "object"
            ? value !== null &&
              typeof value === "object" &&
              !Array.isArray(value)
            : t === "integer"
              ? typeof value === "number" && Number.isInteger(value)
              : typeof value === t;
    if (!(Array.isArray(s.type) ? s.type : [s.type]).some(matches))
      return false;
  }
  if (s.enum && !(s.enum as unknown[]).some((x) => equal(x, value)))
    return false;
  if ("const" in s && !equal(s.const, value)) return false;
  if (s.anyOf && !(s.anyOf as JsonSchema[]).some((x) => valid(x, value)))
    return false;
  if (
    s.oneOf &&
    (s.oneOf as JsonSchema[]).filter((x) => valid(x, value)).length !== 1
  )
    return false;
  if (s.allOf && !(s.allOf as JsonSchema[]).every((x) => valid(x, value)))
    return false;
  if (
    typeof value === "number" &&
    ((typeof s.minimum === "number" && value < s.minimum) ||
      (typeof s.maximum === "number" && value > s.maximum))
  )
    return false;
  if (
    typeof value === "string" &&
    ((typeof s.minLength === "number" && [...value].length < s.minLength) ||
      (typeof s.maxLength === "number" && [...value].length > s.maxLength))
  )
    return false;
  if (Array.isArray(value)) {
    if (
      (typeof s.minItems === "number" && value.length < s.minItems) ||
      (typeof s.maxItems === "number" && value.length > s.maxItems)
    )
      return false;
    if (
      s.items !== undefined &&
      !value.every((x) => valid(s.items as JsonSchema, x))
    )
      return false;
  } else if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>,
      props = (s.properties ?? {}) as Record<string, JsonSchema>;
    if (
      s.required &&
      !(s.required as string[]).every((k) => Object.hasOwn(obj, k))
    )
      return false;
    for (const [k, v] of Object.entries(obj)) {
      if (Object.hasOwn(props, k)) {
        if (!valid(props[k], v)) return false;
      } else if (
        s.additionalProperties === false ||
        (typeof s.additionalProperties === "object" &&
          !valid(s.additionalProperties as JsonSchema, v))
      )
        return false;
    }
  }
  return true;
}
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    !a ||
    !b ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  return (
    Object.keys(x).length === Object.keys(y).length &&
    Object.keys(x).every((k) => Object.hasOwn(y, k) && equal(x[k], y[k]))
  );
}
export function schemaFor(
  output?: OutputSchema,
  explicit?: JsonSchema,
): JsonSchema | undefined {
  if (explicit !== undefined) return explicit;
  if (output === undefined) return undefined;
  if (typeof output === "object" && "~standard" in output) return undefined;
  if (typeof output === "object" && typeof output.parse === "function")
    return (output as Validator).jsonSchema;
  checkSchema(output as JsonSchema);
  return output as JsonSchema;
}
export async function validateOutput<T>(
  text: string,
  output: OutputSchema<T>,
): Promise<T> {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof output === "object" && "~standard" in output) {
      const result = await (output as StandardSchema<T>)["~standard"].validate(
        value,
      );
      if (result.issues) throw new LLMValidationError();
      return result.value as T;
    }
    if (typeof output === "object" && typeof output.parse === "function")
      return await (output as Validator<T>).parse(value);
    checkSchema(output as JsonSchema);
    if (!valid(output as JsonSchema, value)) throw new LLMValidationError();
    return value as T;
  } catch (e) {
    if (e instanceof LLMConfigurationError) throw e;
    throw new LLMValidationError();
  }
}
