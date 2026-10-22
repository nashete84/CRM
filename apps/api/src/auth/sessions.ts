import { createHash, randomBytes } from "node:crypto";
import type { Tx } from "@crm/db";
import { sql } from "kysely";

/** 256 bits from the CSPRNG. The client holds the token; the database holds its hash. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type NewSession = {
  orgId: string;
  userId: string;
  method: "local" | "oidc";
  ttlHours: number;
  ip: string | null;
  userAgent: string | null;
};

/** Creates a session inside an org-scoped transaction and returns the bearer token. */
export async function createSession(
  tx: Tx,
  s: NewSession,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const row = await tx
    .insertInto("user_session")
    .values({
      id: hashToken(token),
      org_id: s.orgId,
      user_id: s.userId,
      method: s.method,
      expires_at: sql`now() + make_interval(hours => ${s.ttlHours})`,
      ip: s.ip,
      user_agent: s.userAgent?.slice(0, 512) ?? null,
    })
    .returning("expires_at")
    .executeTakeFirstOrThrow();
  return { token, expiresAt: row.expires_at };
}

export async function revokeSession(tx: Tx, tokenHash: string): Promise<void> {
  await tx
    .updateTable("user_session")
    .set({ revoked_at: sql`now()` })
    .where("id", "=", tokenHash)
    .where("revoked_at", "is", null)
    .execute();
}
