import { type Db, resolveOrgBySlug, withOrg } from "@crm/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { verifyPassword } from "./password.js";
import { sessionCookieName, sessionCookieOptions } from "./plugin.js";
import { createSession } from "./sessions.js";

const body = z.object({
  org: z.string().min(1).max(64),
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});

const INVALID = { errorCode: "INVALID_LOGIN", message: "Email or password is incorrect." };

/**
 * Email + password sign-in for development (DECISIONS.md D-009). Every failure
 * returns the same message after the same amount of work, so the response
 * doesn't reveal whether the org, the user or the password was wrong.
 */
export function registerLocalLogin(app: FastifyInstance, db: Db, config: Config): void {
  if (!config.ALLOW_LOCAL_LOGIN) return;

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = body.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ errorCode: "INVALID_REQUEST", message: "org, email and password are required." });
      }
      const { org, email, password } = parsed.data;

      const orgId = await resolveOrgBySlug(db, org);
      if (!orgId) {
        await verifyPassword(password, null);
        return reply.code(401).send(INVALID);
      }

      const result = await withOrg(db, orgId, async (tx) => {
        const user = await tx
          .selectFrom("app_user as u")
          .leftJoin("local_credential as c", "c.user_id", "u.id")
          .select(["u.id", "u.is_active", "c.password_hash"])
          .where("u.email", "=", email)
          .executeTakeFirst();
        const ok = await verifyPassword(password, user?.password_hash ?? null);
        if (!user || !ok || !user.is_active) return null;
        return createSession(tx, {
          orgId,
          userId: user.id,
          method: "local",
          ttlHours: config.SESSION_TTL_HOURS,
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
      });

      if (!result) return reply.code(401).send(INVALID);
      reply.setCookie(
        sessionCookieName(config),
        result.token,
        sessionCookieOptions(config, result.expiresAt),
      );
      // The token is also returned for API clients that can't hold cookies.
      return {
        access_token: result.token,
        token_type: "Bearer",
        expires_at: result.expiresAt.toISOString(),
      };
    },
  );
}
