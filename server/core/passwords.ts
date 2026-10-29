import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

// scrypt is overloaded, so the promisified form needs its shape stated explicitly.
const derive = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const COST = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export function newSalt(): string {
  return randomBytes(16).toString("base64");
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await derive(password, salt, KEY_LENGTH, COST);
  return key.toString("base64");
}

export async function verifyPassword(password: string, salt: string, expected: string): Promise<boolean> {
  const actual = Buffer.from(await hashPassword(password, salt), "base64");
  const target = Buffer.from(expected, "base64");
  if (actual.length !== target.length) return false;
  return timingSafeEqual(actual, target);
}
