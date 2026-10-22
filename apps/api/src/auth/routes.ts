import type { Db } from "@crm/db";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { orgScope, requireAuth, sessionCookieName } from "./plugin.js";
import { revokeSession } from "./sessions.js";

export function registerSessionRoutes(app: FastifyInstance, db: Db, config: Config): void {
  app.get("/auth/me", { preHandler: requireAuth }, async (req) => {
    const auth = req.auth;
    if (!auth) throw new Error("unreachable");
    return orgScope(
      db,
      req,
    )(async (tx) => {
      const user = await tx
        .selectFrom("app_user")
        .select(["id", "email", "name", "time_zone", "locale"])
        .where("id", "=", auth.userId)
        .executeTakeFirstOrThrow();
      const org = await tx
        .selectFrom("org")
        .select(["id", "name", "slug"])
        .executeTakeFirstOrThrow();
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          timeZone: user.time_zone,
          locale: user.locale,
        },
        org,
      };
    });
  });

  app.post("/auth/logout", { preHandler: requireAuth }, async (req, reply) => {
    const auth = req.auth;
    if (!auth) throw new Error("unreachable");
    await orgScope(db, req)((tx) => revokeSession(tx, auth.tokenHash));
    reply.clearCookie(sessionCookieName(config), { path: "/" });
    return reply.code(204).send();
  });
}
