import { type Db, type IdentityProviderTable, type Tx, resolveOrgBySlug, withOrg } from "@crm/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Selectable } from "kysely";
import * as oidc from "openid-client";
import { z } from "zod";
import type { Config } from "../config.js";
import { sessionCookieName, sessionCookieOptions } from "./plugin.js";
import { createSession } from "./sessions.js";

type Provider = Selectable<IdentityProviderTable>;

const STATE_COOKIE = "crm_oidc";
const STATE_MAX_AGE_S = 600;

// What the browser carries between /start and /callback, in a signed cookie.
const loginState = z.object({
  o: z.string(), // org id
  p: z.string(), // provider id
  s: z.string(), // state
  n: z.string(), // nonce
  v: z.string(), // PKCE code verifier
  t: z.number(), // issued at, ms
});

/** Discovery documents, cached per provider and issuer. A failed lookup is not cached. */
const discovered = new Map<string, Promise<oidc.Configuration>>();

function clientConfig(provider: Provider, config: Config): Promise<oidc.Configuration> {
  const key = `${provider.id}|${provider.issuer}|${provider.client_id}`;
  let pending = discovered.get(key);
  if (!pending) {
    const secret = process.env[provider.client_secret_env];
    if (!secret) {
      return Promise.reject(
        new Error(`Environment variable ${provider.client_secret_env} is not set`),
      );
    }
    pending = oidc.discovery(
      new URL(provider.issuer),
      provider.client_id,
      secret,
      undefined,
      config.OIDC_ALLOW_INSECURE_HTTP ? { execute: [oidc.allowInsecureRequests] } : undefined,
    );
    pending.catch(() => discovered.delete(key));
    discovered.set(key, pending);
  }
  return pending;
}

export function clearOidcCache(): void {
  discovered.clear();
}

async function activeProvider(tx: Tx, providerId: string): Promise<Provider | undefined> {
  return tx
    .selectFrom("identity_provider")
    .selectAll()
    .where("id", "=", providerId)
    .where("is_active", "=", true)
    .executeTakeFirst();
}

type Claims = { sub: string; email?: unknown; email_verified?: unknown };

/**
 * Finds the CRM user for an IdP account. Returning users are matched only by
 * (provider, subject). Matching by email happens once, on first sign-in, and
 * only if the org allowed it for this provider and the IdP verified the email.
 */
export async function findOrLinkUser(
  tx: Tx,
  orgId: string,
  provider: Provider,
  claims: Claims,
): Promise<{ userId: string } | { refused: string }> {
  // OIDC caps sub at 255 ASCII characters; anything else is not a valid IdP.
  if (claims.sub.length === 0 || claims.sub.length > 255) return { refused: "NOT_LINKED" };
  const linked = await tx
    .selectFrom("user_identity as i")
    .innerJoin("app_user as u", "u.id", "i.user_id")
    .select(["u.id", "u.is_active"])
    .where("i.provider_id", "=", provider.id)
    .where("i.subject", "=", claims.sub)
    .executeTakeFirst();
  if (linked) return linked.is_active ? { userId: linked.id } : { refused: "USER_INACTIVE" };

  if (!provider.allow_email_linking) return { refused: "NOT_LINKED" };
  if (claims.email_verified !== true || typeof claims.email !== "string")
    return { refused: "EMAIL_NOT_VERIFIED" };

  const user = await tx
    .selectFrom("app_user")
    .select(["id", "is_active"])
    .where("email", "=", claims.email)
    .executeTakeFirst();
  if (!user) return { refused: "NOT_LINKED" };
  if (!user.is_active) return { refused: "USER_INACTIVE" };

  // A user may hold one identity per provider; a second subject is refused.
  const inserted = await tx
    .insertInto("user_identity")
    .values({ provider_id: provider.id, subject: claims.sub, org_id: orgId, user_id: user.id })
    .onConflict((oc) => oc.doNothing())
    .returning("user_id")
    .executeTakeFirst();
  return inserted ? { userId: user.id } : { refused: "ALREADY_LINKED" };
}

const REFUSED_MESSAGE: Record<string, string> = {
  NOT_LINKED: "This account isn't linked to a CRM user. Ask your administrator to add you.",
  EMAIL_NOT_VERIFIED: "Your identity provider hasn't verified your email address.",
  USER_INACTIVE: "Your CRM user is deactivated. Ask your administrator.",
  ALREADY_LINKED: "Your CRM user is already linked to a different account at this provider.",
};

export function registerOidc(app: FastifyInstance, db: Db, config: Config): void {
  const fail = (reply: FastifyReply, code: number, errorCode: string, message: string) => {
    reply.clearCookie(STATE_COOKIE, { path: "/auth/oidc" });
    return reply.code(code).send({ errorCode, message });
  };

  app.get<{ Params: { org: string; provider: string } }>(
    "/auth/:org/oidc/:provider",
    async (req, reply) => {
      const orgId = await resolveOrgBySlug(db, req.params.org);
      const provider = orgId
        ? await withOrg(db, orgId, (tx) => activeProvider(tx, req.params.provider))
        : undefined;
      if (!orgId || !provider) {
        return reply
          .code(404)
          .send({ errorCode: "NOT_FOUND", message: "Unknown organization or sign-in method." });
      }

      let client: oidc.Configuration;
      try {
        client = await clientConfig(provider, config);
      } catch (err) {
        req.log.error({ err, providerId: provider.id }, "OIDC discovery failed");
        return reply.code(502).send({
          errorCode: "IDP_UNAVAILABLE",
          message: "The identity provider can't be reached.",
        });
      }

      const state = {
        o: orgId,
        p: provider.id,
        s: oidc.randomState(),
        n: oidc.randomNonce(),
        v: oidc.randomPKCECodeVerifier(),
        t: Date.now(),
      };
      const url = oidc.buildAuthorizationUrl(client, {
        redirect_uri: config.OIDC_REDIRECT_URL,
        scope: "openid email profile",
        state: state.s,
        nonce: state.n,
        code_challenge: await oidc.calculatePKCECodeChallenge(state.v),
        code_challenge_method: "S256",
      });
      reply.setCookie(STATE_COOKIE, JSON.stringify(state), {
        signed: true,
        httpOnly: true,
        secure: config.APP_ORIGIN.startsWith("https://"),
        sameSite: "lax", // must survive the top-level redirect back from the IdP
        path: "/auth/oidc",
        maxAge: STATE_MAX_AGE_S,
      });
      return reply.redirect(url.href, 302);
    },
  );

  app.get("/auth/oidc/callback", async (req, reply) => {
    const raw = req.cookies[STATE_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    let state: z.infer<typeof loginState>;
    try {
      if (!unsigned?.valid || unsigned.value === null) throw new Error("missing or tampered");
      state = loginState.parse(JSON.parse(unsigned.value));
      if (Date.now() - state.t > STATE_MAX_AGE_S * 1000) throw new Error("expired");
    } catch {
      return fail(reply, 400, "LOGIN_STATE_INVALID", "Your sign-in attempt expired. Start again.");
    }
    reply.clearCookie(STATE_COOKIE, { path: "/auth/oidc" });

    const provider = await withOrg(db, state.o, (tx) => activeProvider(tx, state.p));
    if (!provider)
      return fail(reply, 400, "LOGIN_STATE_INVALID", "This sign-in method is no longer available.");

    let claims: Claims;
    try {
      const client = await clientConfig(provider, config);
      const callbackUrl = new URL(config.OIDC_REDIRECT_URL);
      callbackUrl.search = new URL(req.url, "http://placeholder").search;
      const tokens = await oidc.authorizationCodeGrant(client, callbackUrl, {
        pkceCodeVerifier: state.v,
        expectedState: state.s,
        expectedNonce: state.n,
        idTokenExpected: true,
      });
      const idClaims = tokens.claims();
      if (!idClaims) throw new Error("no ID token claims");
      claims = idClaims;
    } catch (err) {
      req.log.warn({ err, providerId: provider.id }, "OIDC code exchange failed");
      return fail(
        reply,
        400,
        "IDP_LOGIN_FAILED",
        "The identity provider didn't confirm your sign-in. Try again.",
      );
    }

    const outcome = await withOrg(db, state.o, async (tx) => {
      const found = await findOrLinkUser(tx, state.o, provider, claims);
      if ("refused" in found) return found;
      return createSession(tx, {
        orgId: state.o,
        userId: found.userId,
        method: "oidc",
        ttlHours: config.SESSION_TTL_HOURS,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });
    });

    if ("refused" in outcome) {
      req.log.info({ providerId: provider.id, reason: outcome.refused }, "OIDC sign-in refused");
      return fail(
        reply,
        403,
        outcome.refused,
        REFUSED_MESSAGE[outcome.refused] ?? "Sign-in refused.",
      );
    }
    reply.setCookie(
      sessionCookieName(config),
      outcome.token,
      sessionCookieOptions(config, outcome.expiresAt),
    );
    return reply.redirect("/", 302);
  });
}
