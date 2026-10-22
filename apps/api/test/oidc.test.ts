import { type Db, KeyPrefix, newId, withOrg } from "@crm/db";
import type { FastifyInstance } from "fastify";
import { OAuth2Server } from "oauth2-mock-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearOidcCache } from "../src/auth/oidc.js";
import { type SeedOrg, cookieFrom, hasDb, makeApp, seedOrg, setupDb } from "./helpers.js";

const SECRET_ENV = "TEST_IDP_CLIENT_SECRET";

describe.skipIf(!hasDb)("OIDC sign-in", () => {
  let db: Db;
  let admin: Db;
  let app: FastifyInstance;
  let idp: OAuth2Server;
  let alpha: SeedOrg;
  let bravo: SeedOrg;
  let strictProvider: string; // alpha: no email linking
  let linkingProvider: string; // alpha: email linking on
  let bravoProvider: string;

  // Claims the mock IdP puts in the next ID token.
  let nextClaims: Record<string, unknown> = {};

  async function addProvider(org: SeedOrg, emailLinking: boolean): Promise<string> {
    const id = newId(KeyPrefix.AuthProvider);
    await withOrg(db, org.id, (tx) =>
      tx
        .insertInto("identity_provider")
        .values({
          id,
          org_id: org.id,
          name: "Mock IdP",
          issuer: idp.issuer.url ?? "",
          client_id: "crm-client",
          client_secret_env: SECRET_ENV,
          allow_email_linking: emailLinking,
        })
        .execute(),
    );
    return id;
  }

  /** Runs the browser's side of the flow and returns the callback response. */
  async function signIn(orgSlug: string, providerId: string, claims: Record<string, unknown>) {
    nextClaims = claims;
    const start = await app.inject({ method: "GET", url: `/auth/${orgSlug}/oidc/${providerId}` });
    expect(start.statusCode).toBe(302);
    const stateCookie = cookieFrom(start, "crm_oidc");
    expect(stateCookie).not.toBeNull();

    // The mock IdP approves immediately and redirects back with a code.
    const authorize = await fetch(String(start.headers.location), { redirect: "manual" });
    const back = new URL(String(authorize.headers.get("location")));
    expect(back.pathname).toBe("/auth/oidc/callback");

    return {
      back,
      stateCookie: stateCookie ?? "",
      callback: (overrides: { cookie?: string | null; search?: string } = {}) =>
        app.inject({
          method: "GET",
          url: `/auth/oidc/callback${overrides.search ?? back.search}`,
          cookies:
            overrides.cookie === null ? {} : { crm_oidc: overrides.cookie ?? stateCookie ?? "" },
        }),
    };
  }

  beforeAll(async () => {
    process.env[SECRET_ENV] = "mock-secret";
    idp = new OAuth2Server();
    await idp.issuer.keys.generate("RS256");
    await idp.start(0, "127.0.0.1");
    idp.service.on("beforeTokenSigning", (token) => {
      Object.assign(token.payload, nextClaims);
    });

    ({ db, admin } = await setupDb());
    alpha = await seedOrg(db, "alpha", ["alice", "dave", "frank"], {});
    bravo = await seedOrg(db, "bravo", ["bob"]);
    strictProvider = await addProvider(alpha, false);
    linkingProvider = await addProvider(alpha, true);
    bravoProvider = await addProvider(bravo, true);
    await withOrg(db, alpha.id, (tx) =>
      tx
        .insertInto("user_identity")
        .values({
          provider_id: strictProvider,
          subject: "alice-sub",
          org_id: alpha.id,
          user_id: alpha.users.alice?.id ?? "",
        })
        .execute(),
    );
    app = await makeApp(db, { ALLOW_LOCAL_LOGIN: "false" });
  });

  afterEach(() => {
    nextClaims = {};
  });

  afterAll(async () => {
    await app.close();
    await idp.stop();
    clearOidcCache();
    await admin.deleteFrom("org").where("id", "in", [alpha.id, bravo.id]).execute();
    await admin.destroy();
    await db.destroy();
  });

  it("signs in a linked user and starts a session", async () => {
    const { callback } = await signIn(alpha.slug, strictProvider, { sub: "alice-sub" });
    const res = await callback();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
    const sid = cookieFrom(res, "crm_sid");
    expect(sid).toBeTruthy();
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { crm_sid: sid ?? "" },
    });
    expect(me.json().user.id).toBe(alpha.users.alice?.id);
  });

  it("refuses an unlinked account when email linking is off, even with a matching email", async () => {
    const { callback } = await signIn(alpha.slug, strictProvider, {
      sub: "dave-sub",
      email: alpha.users.dave?.email,
      email_verified: true,
    });
    const res = await callback();
    expect(res.statusCode).toBe(403);
    expect(res.json().errorCode).toBe("NOT_LINKED");
  });

  it("links by verified email on first sign-in, then recognises the subject", async () => {
    const first = await (
      await signIn(alpha.slug, linkingProvider, {
        sub: "dave-sub",
        email: alpha.users.dave?.email,
        email_verified: true,
      })
    ).callback();
    expect(first.statusCode).toBe(302);

    // Second time the email has changed at the IdP; the subject still matches.
    const again = await (
      await signIn(alpha.slug, linkingProvider, {
        sub: "dave-sub",
        email: "dave-renamed@elsewhere.test",
        email_verified: true,
      })
    ).callback();
    expect(again.statusCode).toBe(302);
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { crm_sid: cookieFrom(again, "crm_sid") ?? "" },
    });
    expect(me.json().user.id).toBe(alpha.users.dave?.id);
  });

  it("refuses an unverified email", async () => {
    const res = await (
      await signIn(alpha.slug, linkingProvider, {
        sub: "frank-sub",
        email: alpha.users.frank?.email,
        email_verified: false,
      })
    ).callback();
    expect(res.statusCode).toBe(403);
    expect(res.json().errorCode).toBe("EMAIL_NOT_VERIFIED");
  });

  it("refuses a second account trying to claim an already linked user", async () => {
    const res = await (
      await signIn(alpha.slug, linkingProvider, {
        sub: "attacker-sub",
        email: alpha.users.dave?.email,
        email_verified: true,
      })
    ).callback();
    expect(res.statusCode).toBe(403);
    expect(res.json().errorCode).toBe("ALREADY_LINKED");
  });

  it("never links to a user in another org by email", async () => {
    const res = await (
      await signIn(alpha.slug, linkingProvider, {
        sub: "bob-in-alpha",
        email: bravo.users.bob?.email,
        email_verified: true,
      })
    ).callback();
    expect(res.statusCode).toBe(403);
    expect(res.json().errorCode).toBe("NOT_LINKED");
  });

  it("will not start a sign-in with another org's provider", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/auth/${alpha.slug}/oidc/${bravoProvider}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a callback without the login cookie, or with a tampered one", async () => {
    const flow = await signIn(alpha.slug, strictProvider, { sub: "alice-sub" });
    const missing = await flow.callback({ cookie: null });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().errorCode).toBe("LOGIN_STATE_INVALID");

    // Re-sign the payload with a different org: the signature no longer matches.
    const [payload] = flow.stateCookie.split(/\.(?=[^.]+$)/);
    const forged = JSON.parse(payload ?? "{}");
    forged.o = bravo.id;
    const tampered = await flow.callback({
      cookie: `${JSON.stringify(forged)}.AAAA`,
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().errorCode).toBe("LOGIN_STATE_INVALID");
  });

  it("rejects a callback whose state doesn't match the browser's login", async () => {
    const flow = await signIn(alpha.slug, strictProvider, { sub: "alice-sub" });
    const wrongState = new URLSearchParams(flow.back.search);
    wrongState.set("state", "attacker-chosen-state");
    const res = await flow.callback({ search: `?${wrongState}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe("IDP_LOGIN_FAILED");
    expect(cookieFrom(res, "crm_sid")).toBeNull();
  });

  it("rejects a replayed authorization code", async () => {
    const flow = await signIn(alpha.slug, strictProvider, { sub: "alice-sub" });
    expect((await flow.callback()).statusCode).toBe(302);
    // Same code and cookie again: the mock IdP has consumed the nonce, so the
    // ID token no longer carries it and the nonce check fails.
    const replay = await flow.callback();
    expect(replay.statusCode).toBe(400);
  });
});
