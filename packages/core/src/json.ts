/**
 * JSON value contracts.
 *
 * Every AxonEvent has to survive two hops it does not control: the Electron
 * IPC structured-clone boundary, and a JSONL line on disk. Typing event
 * payloads as `unknown` would let a Buffer, a Date or a class instance into an
 * event and the loss would only show up later, in the log, as `{}`.
 *
 * Constraining payloads to JsonValue makes that a compile error instead.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

import { z } from 'zod';

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * Best-effort conversion of an arbitrary value into a JsonValue.
 *
 * Used at the edges where a value comes from outside our type system (a thrown
 * error, a tool's raw output). Anything that cannot be represented becomes a
 * string rather than silently vanishing during serialization.
 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return String(value);
    case 'undefined':
    case 'function':
    case 'symbol':
      return null;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonValue(entry);
    }
    return out;
  }
  return String(value);
}
