import { type Db, type Tx, resolveSession, withOrg } from "@crm/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "kysely";
import type { Config } from "../config.js";
import { hashToken } from "./sessions.js";

export type AuthContext = {
  orgId: string;
  userId: string;
  tokenHash: string;
  via: "cookie" | "bearer";
};

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TOUCH_INTERVAL_MS = 60_000;

export function sessionCookieName(config: Config): string {
  // __Host- forces Secure, Path=/ and no Domain, so subdomains can't set or read it.
  return config.APP_ORIGIN.startsWith("https://") ? "__Host-crm_sid" : "crm_sid";
}

export function sessionCookieOptions(config: Config, expires?: Date) {
  return {
    httpOnly: true,
    secure: config.APP_ORIGIN.startsWith("https://"),
    sameSite: "lax" as const,
    path: "/",
    ...(expires ? { expires } : {}),
  };
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(header);
  return match?.[1] ?? null;
}

/**
 * Resolves who is calling. Sets `req.auth` or leaves it null; never rejects by
 * itself except for cross-site writes. Routes opt in with `requireAuth`.
 */
export function registerAuth(app: FastifyInstance, db: Db, config: Config): void {
  const cookieName = sessionCookieName(config);
  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (req, reply) => {
    const bearer = bearerToken(req);
    const cookie = bearer ? null : (req.cookies[cookieName] ?? null);
    const via = bearer ? "bearer" : "cookie";

    // Cross-site request forgery: browsers attach cookies to cross-site
    // requests, so an unsafe request may only use the cookie, or sign in,
    // when the browser says it came from our own origin.
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== config.APP_ORIGIN) {
        return reply
          .code(403)
          .send({ errorCode: "FORBIDDEN_ORIGIN", message: "Cross-site request refused." });
      }
      if (cookie && origin === undefined) {
        return reply.code(403).send({
          errorCode: "FORBIDDEN_ORIGIN",
          message: "Requests that use the session cookie must send an Origin header.",
        });
      }
    }

    const token = bearer ?? cookie;
    if (!token) return;
    const tokenHash = hashToken(token);
    const session = await resolveSession(db, tokenHash, config.SESSION_IDLE_MINUTES);
    if (!session) {
      if (via === "cookie") reply.clearCookie(cookieName, { path: "/" });
      return;
    }
    req.auth = { orgId: session.orgId, userId: session.userId, tokenHash, via };

    if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await withOrg(db, session.orgId, (tx) =>
        tx
          .updateTable("user_session")
          .set({ last_seen_at: sql`now()` })
          .where("id", "=", tokenHash)
          .execute(),
      );
    }
  });
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth) {
    await reply
      .code(401)
      .send({ errorCode: "INVALID_SESSION_ID", message: "Session expired or invalid." });
  }
}

/** Runs `fn` scoped to the caller's org. Throws if called on an unauthenticated route. */
export function orgScope(
  db: Db,
  req: FastifyRequest,
): <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> {
  const auth = req.auth;
  if (!auth) throw new Error("orgScope used on an unauthenticated request");
  return (fn) => withOrg(db, auth.orgId, fn);
}
