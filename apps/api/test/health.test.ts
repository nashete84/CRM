import { createDb } from "@crm/db";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("lists every invalid variable at once", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrowError(/DATABASE_URL[\s\S]*PORT/);
  });
});

describe("health endpoints", () => {
  it("reports not ready when the database is unreachable", async () => {
    const db = createDb("postgres://nobody:nothing@127.0.0.1:1/none", { max: 1 });
    const app = buildApp({ db, logLevel: "silent" });
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "unavailable", database: "unreachable" });
    await app.close();
    await db.destroy();
  });

  describe.skipIf(!process.env.DATABASE_URL)("with a database", () => {
    const db = createDb(process.env.DATABASE_URL ?? "", { max: 1 });
    afterAll(() => db.destroy());

    it("reports ready", async () => {
      const app = buildApp({ db, logLevel: "silent" });
      const res = await app.inject({ method: "GET", url: "/health/ready" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok", database: "ok" });
      await app.close();
    });
  });
});
