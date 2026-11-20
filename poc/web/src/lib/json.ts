export type JsonObject = Record<string, unknown>;

/** Canonical JSON object guard for untrusted wire data. */
export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const asObject = (value: unknown): JsonObject =>
  isObject(value) ? value : {};

export const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

export const asStrings = (value: unknown): string[] =>
  asArray(value).filter((item): item is string => typeof item === "string");
