import { randomInt } from "node:crypto";

/**
 * Salesforce-compatible record IDs (DECISIONS.md D-014).
 *
 * An ID is 15 case-sensitive base62 characters: a 3-character key prefix that
 * names the object (00D org, 005 user), then 12 random characters. The 18-character
 * form appends a 3-character suffix encoding which of the 15 characters are
 * uppercase, so the ID survives case-insensitive systems (spreadsheets, URLs).
 * We always store and emit the 18-character form.
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SUFFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
const PREFIX_RE = /^[0-9A-Za-z]{3}$/;
const ID15_RE = /^[0-9A-Za-z]{15}$/;
const ID18_RE = /^[0-9A-Za-z]{15}[A-Z0-5]{3}$/;

export const KeyPrefix = {
  Org: "00D",
  User: "005",
  AuthProvider: "0SO",
} as const;

/** Appends the case-checksum suffix to a 15-character ID. */
export function to18(id15: string): string {
  if (!ID15_RE.test(id15)) throw new Error(`Not a 15-character ID: ${id15}`);
  let suffix = "";
  for (let chunk = 0; chunk < 3; chunk++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) {
      const c = id15.charCodeAt(chunk * 5 + i);
      if (c >= 65 && c <= 90) bits |= 1 << i; // A-Z
    }
    suffix += SUFFIX_ALPHABET[bits];
  }
  return id15 + suffix;
}

/** True if `id` is a well-formed 18-character ID whose suffix matches its case. */
export function isValidId(id: string, prefix?: string): boolean {
  if (!ID18_RE.test(id)) return false;
  if (prefix !== undefined && !id.startsWith(prefix)) return false;
  return to18(id.slice(0, 15)) === id;
}

/**
 * Accepts a 15- or 18-character ID in any letter case for the suffix and returns
 * the canonical 18-character form, or null. A 15-character ID is case-sensitive,
 * so it is taken as given.
 */
export function normalizeId(id: string): string | null {
  if (ID15_RE.test(id)) return to18(id);
  if (id.length !== 18) return null;
  const id15 = id.slice(0, 15);
  if (!ID15_RE.test(id15)) return null;
  const canonical = to18(id15);
  return canonical.slice(15) === id.slice(15).toUpperCase() ? canonical : null;
}

export function newId(prefix: string): string {
  if (!PREFIX_RE.test(prefix)) throw new Error(`Invalid key prefix: ${prefix}`);
  let body = "";
  for (let i = 0; i < 12; i++) body += BASE62[randomInt(62)];
  return to18(prefix + body);
}
