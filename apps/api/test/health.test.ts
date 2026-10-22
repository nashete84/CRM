import { createDb } from "@crm/db";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { appUrl, makeApp } from "./helpers.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/crm",
  COOKIE_SECRET: "x".repeat(32),
};

describe("config", () => {
  it("lists every invalid variable at once", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrowError(
      /DATABASE_URL[\s\S]*PORT[\s\S]*COOKIE_SECRET/,
    );
  });

  it("refuses development-only switches and plain http in production", () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: "production",
        APP_ORIGIN: "http://crm.example",
        ALLOW_LOCAL_LOGIN: "true",
        OIDC_ALLOW_INSECURE_HTTP: "true",
      }),
    ).toThrowError(/ALLOW_LOCAL_LOGIN[\s\S]*OIDC_ALLOW_INSECURE_HTTP[\s\S]*APP_ORIGIN/);
  });

  it("derives the OIDC callback from the app origin", () => {
    const c = loadConfig({ ...base, APP_ORIGIN: "https://crm.example/some/path" });
    expect(c.APP_ORIGIN).toBe("https://crm.example");
    expect(c.OIDC_REDIRECT_URL).toBe("https://crm.example/auth/oidc/callback");
    expect(c.ALLOW_LOCAL_LOGIN).toBe(false);
  });
});

describe("health endpoints", () => {
  it("reports not ready when the database is unreachable", async () => {
    const db = createDb("postgres://nobody:nothing@127.0.0.1:1/none", { max: 1 });
    const app = await makeApp(db);
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "unavailable", database: "unreachable" });
    await app.close();
    await db.destroy();
  });

  describe.skipIf(!appUrl)("with a database", () => {
    const db = createDb(appUrl ?? "", { max: 1 });
    afterAll(() => db.destroy());

    it("reports ready", async () => {
      const app = await makeApp(db);
      const res = await app.inject({ method: "GET", url: "/health/ready" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok", database: "ok" });
      await app.close();
    });
  });
});

describe("error handling", () => {
  it("answers unexpected errors without leaking their message", async () => {
    const db = createDb("postgres://nobody:nothing@127.0.0.1:1/none", { max: 1 });
    const app = await makeApp(db);
    app.get("/boom", async () => {
      throw new Error('relation "secret_table" does not exist');
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret_table");
    expect(res.json().errorCode).toBe("UNKNOWN_EXCEPTION");
    await app.close();
    await db.destroy();
  });
});
