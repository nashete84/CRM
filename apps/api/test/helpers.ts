import { randomBytes } from "node:crypto";
import { type Db, KeyPrefix, createDb, migrateToLatest, newId, withOrg } from "@crm/db";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { type Config, loadConfig } from "../src/config.js";

export const adminUrl = process.env.DATABASE_ADMIN_URL;
export const appUrl = process.env.DATABASE_URL;
export const hasDb = Boolean(adminUrl && appUrl);

export const ORIGIN = "http://localhost:3000";
export const PASSWORD = "correct horse battery staple";

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl ?? "postgres://unused@127.0.0.1:1/unused",
    LOG_LEVEL: "silent",
    APP_ORIGIN: ORIGIN,
    COOKIE_SECRET: "test-cookie-secret-that-is-at-least-32-chars",
    ALLOW_LOCAL_LOGIN: "true",
    OIDC_ALLOW_INSECURE_HTTP: "true",
    LOGIN_RATE_LIMIT_PER_MINUTE: "1000",
    ...env,
  });
}

export async function makeApp(db: Db, env: Record<string, string> = {}): Promise<FastifyInstance> {
  return buildApp({ db, config: testConfig(env) });
}

export type SeedUser = { id: string; email: string };
export type SeedOrg = { id: string; slug: string; users: Record<string, SeedUser> };

/** Creates an org with the named users. Every user gets PASSWORD unless listed in `noPassword`. */
export async function seedOrg(
  db: Db,
  label: string,
  users: string[],
  opts: { inactive?: string[]; noPassword?: string[] } = {},
): Promise<SeedOrg> {
  const id = newId(KeyPrefix.Org);
  const slug = `${label}-${randomBytes(4).toString("hex")}`;
  const hash = await hashPassword(PASSWORD);
  const seeded: SeedOrg = { id, slug, users: {} };
  await withOrg(db, id, async (tx) => {
    await tx.insertInto("org").values({ id, name: label, slug }).execute();
    for (const name of users) {
      const user = { id: newId(KeyPrefix.User), email: `${name}@${slug}.test` };
      seeded.users[name] = user;
      await tx
        .insertInto("app_user")
        .values({
          id: user.id,
          org_id: id,
          email: user.email,
          name,
          is_active: !opts.inactive?.includes(name),
        })
        .execute();
      if (!opts.noPassword?.includes(name)) {
        await tx
          .insertInto("local_credential")
          .values({ user_id: user.id, org_id: id, password_hash: hash })
          .execute();
      }
    }
  });
  return seeded;
}

export async function setupDb(): Promise<{ db: Db; admin: Db }> {
  const admin = createDb(adminUrl ?? "", { max: 1 });
  await migrateToLatest(admin);
  return { db: createDb(appUrl ?? "", { max: 5 }), admin };
}

export function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  for (const c of list as string[]) {
    const [pair] = c.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0 && pair.slice(0, eq) === name) return decodeURIComponent(pair.slice(eq + 1));
  }
  return null;
}
