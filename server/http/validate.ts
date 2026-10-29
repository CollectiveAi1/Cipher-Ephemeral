/**
 * Explicit per-field parsing. Every route states exactly which fields it accepts and
 * rejects anything else, so a client cannot smuggle an unexpected field past a handler.
 */
import { badRequest } from "./errors.ts";

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** Rejects a body carrying fields the route does not define. */
export function fields(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  const record = asRecord(body);
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw badRequest(`Unexpected field: ${unexpected.join(", ")}`);
  return record;
}

export function str(
  body: Record<string, unknown>,
  key: string,
  options: { min: number; max: number; pattern?: RegExp },
): string {
  const value = body[key];
  if (typeof value !== "string") throw badRequest(`"${key}" must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < options.min) throw badRequest(`"${key}" must be at least ${options.min} characters`);
  if (trimmed.length > options.max) throw badRequest(`"${key}" must be at most ${options.max} characters`);
  if (options.pattern !== undefined && !options.pattern.test(trimmed)) {
    throw badRequest(`"${key}" contains unsupported characters`);
  }
  return trimmed;
}

export function optionalStr(
  body: Record<string, unknown>,
  key: string,
  options: { min: number; max: number; pattern?: RegExp },
): string | undefined {
  return body[key] === undefined ? undefined : str(body, key, options);
}

/**
 * A secret that must survive verbatim. Unlike {@link str} this never trims, because
 * silently altering a password changes what the user typed.
 */
export function secret(body: Record<string, unknown>, key: string, options: { min: number; max: number }): string {
  const value = body[key];
  if (typeof value !== "string") throw badRequest(`"${key}" must be a string`);
  if (value.length < options.min) throw badRequest(`"${key}" must be at least ${options.min} characters`);
  if (value.length > options.max) throw badRequest(`"${key}" must be at most ${options.max} characters`);
  return value;
}

export function int(body: Record<string, unknown>, key: string, options: { min: number; max: number }): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw badRequest(`"${key}" must be an integer`);
  if (value < options.min || value > options.max) {
    throw badRequest(`"${key}" must be between ${options.min} and ${options.max}`);
  }
  return value;
}

export function optionalInt(
  body: Record<string, unknown>,
  key: string,
  options: { min: number; max: number },
): number | undefined {
  return body[key] === undefined ? undefined : int(body, key, options);
}

export function oneOf<T extends string>(body: Record<string, unknown>, key: string, values: readonly T[]): T {
  const value = body[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw badRequest(`"${key}" must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

export function optionalOneOf<T extends string>(
  body: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  return body[key] === undefined ? undefined : oneOf(body, key, values);
}

/** Base64 payload with a decoded-size ceiling, checked before anything decodes it. */
export function base64(body: Record<string, unknown>, key: string, maxBytes: number): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") throw badRequest(`"${key}" must be a base64 string`);
  if (!BASE64.test(value)) throw badRequest(`"${key}" is not valid base64`);
  if (Math.floor((value.length * 3) / 4) > maxBytes) throw badRequest(`"${key}" exceeds ${maxBytes} bytes`);
  return value;
}

export function nullableId(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw badRequest(`"${key}" must be an id or null`);
  }
  return value;
}

/** Parses an array, enforcing a length ceiling before any element is examined. */
export function array(body: Record<string, unknown>, key: string, max: number): unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) throw badRequest(`"${key}" must be an array`);
  if (value.length === 0) throw badRequest(`"${key}" must not be empty`);
  if (value.length > max) throw badRequest(`"${key}" must contain at most ${max} items`);
  return value;
}

export function nested(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  return fields(value, allowed);
}
