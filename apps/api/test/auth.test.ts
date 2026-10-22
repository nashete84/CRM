import type { Db } from "@crm/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ORIGIN,
  PASSWORD,
  type SeedOrg,
  cookieFrom,
  hasDb,
  makeApp,
  seedOrg,
  setupDb,
} from "./helpers.js";

describe.skipIf(!hasDb)("local sign-in and sessions", () => {
  let db: Db;
  let admin: Db;
  let app: FastifyInstance;
  let alpha: SeedOrg;
  let bravo: SeedOrg;

  const login = (org: string, email: string, password = PASSWORD) =>
    app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: ORIGIN },
      payload: { org, email, password },
    });

  beforeAll(async () => {
    ({ db, admin } = await setupDb());
    alpha = await seedOrg(db, "alpha", ["alice", "carol", "erin"], {
      inactive: ["carol"],
      noPassword: ["erin"],
    });
    bravo = await seedOrg(db, "bravo", ["bob"]);
    app = await makeApp(db);
  });

  afterAll(async () => {
    await app.close();
    await admin.deleteFrom("org").where("id", "in", [alpha.id, bravo.id]).execute();
    await admin.destroy();
    await db.destroy();
  });

  it("signs in with the right password and returns a token and a cookie", async () => {
    const res = await login(alpha.slug, `ALICE@${alpha.slug}.test`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieFrom(res, "crm_sid")).toBe(body.access_token);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
  });

  it("gives the same answer for every kind of failure", async () => {
    const failures = await Promise.all([
      login(alpha.slug, alpha.users.alice?.email ?? "", "wrong password!!"),
      login(alpha.slug, `nobody@${alpha.slug}.test`),
      login("no-such-org", alpha.users.alice?.email ?? ""),
      login(alpha.slug, alpha.users.carol?.email ?? ""), // deactivated
      login(alpha.slug, alpha.users.erin?.email ?? ""), // no password set
      login(alpha.slug, bravo.users.bob?.email ?? ""), // right password, other org
    ]);
    for (const res of failures) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        errorCode: "INVALID_LOGIN",
        message: "Email or password is incorrect.",
      });
      expect(cookieFrom(res, "crm_sid")).toBeNull();
    }
  });

  it("identifies the caller by bearer token or by cookie", async () => {
    const token = (await login(alpha.slug, alpha.users.alice?.email ?? "")).json().access_token;
    const byBearer = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    const byCookie = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { crm_sid: token },
    });
    for (const res of [byBearer, byCookie]) {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        user: { id: alpha.users.alice?.id, email: alpha.users.alice?.email },
        org: { id: alpha.id, slug: alpha.slug },
      });
    }
  });

  it("each org's session sees only that org", async () => {
    const token = (await login(bravo.slug, bravo.users.bob?.email ?? "")).json().access_token;
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().org.id).toBe(bravo.id);
    expect(res.json().user.id).toBe(bravo.users.bob?.id);
  });

  it("rejects missing, malformed and unknown tokens", async () => {
    for (const headers of [
      {},
      { authorization: "Bearer short" },
      { authorization: `Bearer ${"A".repeat(43)}` },
      { authorization: "Basic YWxpY2U6cGFzcw==" },
    ]) {
      const res = await app.inject({ method: "GET", url: "/auth/me", headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().errorCode).toBe("INVALID_SESSION_ID");
    }
  });

  it("refuses cookie-authenticated writes from another site or with no origin", async () => {
    const token = (await login(alpha.slug, alpha.users.alice?.email ?? "")).json().access_token;
    const foreign = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { crm_sid: token },
      headers: { origin: "https://evil.example" },
    });
    const missing = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { crm_sid: token },
    });
    expect(foreign.statusCode).toBe(403);
    expect(missing.statusCode).toBe(403);
    // The session survived both attempts.
    const me = await app.inject({ method: "GET", url: "/auth/me", cookies: { crm_sid: token } });
    expect(me.statusCode).toBe(200);
  });

  it("refuses a sign-in posted from another site", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: "https://evil.example" },
      payload: { org: alpha.slug, email: alpha.users.alice?.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });

  it("signs out with the cookie from our origin, and the token stops working", async () => {
    const token = (await login(alpha.slug, alpha.users.alice?.email ?? "")).json().access_token;
    const out = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { crm_sid: token },
      headers: { origin: ORIGIN },
    });
    expect(out.statusCode).toBe(204);
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it("signs out with a bearer token without needing an origin", async () => {
    const token = (await login(alpha.slug, alpha.users.alice?.email ?? "")).json().access_token;
    const out = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.statusCode).toBe(204);
  });

  it("ends a session when its user is deactivated", async () => {
    const token = (await login(alpha.slug, alpha.users.alice?.email ?? "")).json().access_token;
    await admin
      .updateTable("app_user")
      .set({ is_active: false })
      .where("id", "=", alpha.users.alice?.id ?? "")
      .execute();
    try {
      const me = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(401);
    } finally {
      await admin
        .updateTable("app_user")
        .set({ is_active: true })
        .where("id", "=", alpha.users.alice?.id ?? "")
        .execute();
    }
  });

  it("stores only the hash of the token", async () => {
    const token = (await login(alpha.slug, alpha.users.alice?.email ?? "")).json().access_token;
    const rows = await admin.selectFrom("user_session").select("id").execute();
    expect(rows.some((r) => r.id === token)).toBe(false);
  });

  it("has no sign-in endpoint when local login is off", async () => {
    const prodLike = await makeApp(db, { ALLOW_LOCAL_LOGIN: "false" });
    const res = await prodLike.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: ORIGIN },
      payload: { org: alpha.slug, email: alpha.users.alice?.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(404);
    await prodLike.close();
  });

  it("limits sign-in attempts per address", async () => {
    const limited = await makeApp(db, { LOGIN_RATE_LIMIT_PER_MINUTE: "10" });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await limited.inject({
        method: "POST",
        url: "/auth/login",
        headers: { origin: ORIGIN },
        payload: { org: "no-such-org", email: "x@y.test", password: "nope" },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    await limited.close();
  });
});
