import type { Db } from "@crm/db";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "kysely";

export type AppOptions = {
  db: Db;
  logLevel?: string;
};

export function buildApp({ db, logLevel = "info" }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: logLevel },
    // Request ids show up in every log line; Salesforce-style APIs return them too.
    genReqId: () => crypto.randomUUID(),
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

  return app;
}
