import type { Db } from "@crm/db";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { sql } from "kysely";
import { registerLocalLogin } from "./auth/local.js";
import { registerOidc } from "./auth/oidc.js";
import { registerAuth } from "./auth/plugin.js";
import { registerSessionRoutes } from "./auth/routes.js";
import type { Config } from "./config.js";

export type AppOptions = {
  db: Db;
  config: Config;
};

export async function buildApp({ db, config }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never write credentials to logs.
      redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    },
    trustProxy: config.TRUST_PROXY,
    // Request ids show up in every log line; Salesforce-style APIs return them too.
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(cookie, { secret: config.COOKIE_SECRET });
  await app.register(rateLimit, { global: false });

  // Unexpected errors are logged in full but answered generically, so database
  // or library messages never reach the client.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, "unhandled error");
      return reply
        .code(500)
        .send({ errorCode: "UNKNOWN_EXCEPTION", message: "Something went wrong. Try again." });
    }
    return reply
      .code(status)
      .send({ errorCode: err.code ?? "INVALID_REQUEST", message: err.message });
  });

  // Liveness: the process is up. No dependencies, so orchestrators don't restart
  // the API just because the database blipped.
  app.get("/health/live", async () => ({ status: "ok" }));

  // Readiness: the API can serve traffic, which requires the database.
  app.get("/health/ready", async (_req, reply) => {
    try {
      await sql`SELECT 1`.execute(db);
      return { status: "ok", database: "ok" };
    } catch (err) {
      app.log.error({ err }, "readiness check failed");
      return reply.code(503).send({ status: "unavailable", database: "unreachable" });
    }
  });

  registerAuth(app, db, config);
  registerLocalLogin(app, db, config);
  registerOidc(app, db, config);
  registerSessionRoutes(app, db, config);

  return app;
}
