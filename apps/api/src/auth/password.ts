import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt with OWASP-recommended cost (N=2^17, r=8, p=1). Parameters are stored
// in the hash so they can be raised later without invalidating old passwords.
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEYLEN = 32;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEYLEN,
      { N: n, r, p, maxmem: 256 * n * r } /* needs 128*N*r bytes */,
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error("Password must be at least 12 characters");
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

// Verified against when there is no user or no credential, so a wrong email
// takes as long as a wrong password and response time doesn't reveal which.
let dummyHash: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword("dummy-password-for-timing");
  return dummyHash;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const target = stored ?? (await getDummyHash());
  const parts = target.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (!Number.isInteger(n) || n < 2 ** 14 || n > 2 ** 18 || r < 1 || r > 16 || p < 1 || p > 4)
    return false;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  const actual = await derive(password, salt, n, r, p);
  const match = actual.length === expected.length && timingSafeEqual(actual, expected);
  return stored !== null && match;
}
