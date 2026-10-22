import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Db,
  KeyPrefix,
  createDb,
  migrateToLatest,
  newId,
  resolveOrgBySlug,
  resolveSession,
  withOrg,
} from "../src/index.js";

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;

const TENANT_TABLES = [
  "app_user",
  "local_credential",
  "identity_provider",
  "user_identity",
  "user_session",
] as const;

type Org = { id: string; slug: string; userId: string; providerId: string };

async function seedOrg(app: Db, label: string): Promise<Org> {
  const org: Org = {
    id: newId(KeyPrefix.Org),
    slug: `${label}-${randomBytes(4).toString("hex")}`,
    userId: newId(KeyPrefix.User),
    providerId: newId(KeyPrefix.AuthProvider),
  };
  await withOrg(app, org.id, async (tx) => {
    await tx.insertInto("org").values({ id: org.id, name: label, slug: org.slug }).execute();
    await tx
      .insertInto("app_user")
      .values({ id: org.userId, org_id: org.id, email: `admin@${label}.test`, name: "Admin" })
      .execute();
    await tx
      .insertInto("local_credential")
      .values({ user_id: org.userId, org_id: org.id, password_hash: "x" })
      .execute();
    await tx
      .insertInto("identity_provider")
      .values({
        id: org.providerId,
        org_id: org.id,
        name: "IdP",
        issuer: "https://idp.example",
        client_id: "c",
        client_secret_env: "IDP_SECRET",
      })
      .execute();
    await tx
      .insertInto("user_identity")
      .values({
        provider_id: org.providerId,
        subject: "sub-1",
        org_id: org.id,
        user_id: org.userId,
      })
      .execute();
  });
  return org;
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

describe.skipIf(!adminUrl || !appUrl)("tenant isolation", () => {
  const admin = createDb(adminUrl ?? "", { max: 2 });
  const app = createDb(appUrl ?? "", { max: 4 });
  let a: Org;
  let b: Org;

  beforeAll(async () => {
    await migrateToLatest(admin);
    a = await seedOrg(app, "alpha");
    b = await seedOrg(app, "bravo");
  });

  afterAll(async () => {
    await admin.deleteFrom("org").where("id", "in", [a.id, b.id]).execute();
    await admin.destroy();
    await app.destroy();
  });

  it("every table with an org_id column has row-level security and a policy", async () => {
    const { rows } = await sql<{ table: string; rls: boolean; policies: number }>`
      SELECT c.relname AS table, c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND (c.relname = 'org' OR EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public' AND col.table_name = c.relname
            AND col.column_name = 'org_id'))
    `.execute(admin);
    expect(rows.map((r) => r.table).sort()).toEqual(expect.arrayContaining([...TENANT_TABLES]));
    const unprotected = rows.filter((r) => !r.rls || r.policies === 0).map((r) => r.table);
    expect(unprotected).toEqual([]);
  });

  it("the app role owns no table (owners bypass non-forced RLS)", async () => {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_tables
      WHERE schemaname = 'public' AND tableowner = 'crm_app'
    `.execute(admin);
    expect(rows[0]?.n).toBe(0);
  });

  it("with no org set, every tenant table looks empty and writes are refused", async () => {
    for (const table of ["org", ...TENANT_TABLES]) {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM ${sql.table(table)}
      `.execute(app);
      expect(rows[0]?.n, table).toBe(0);
    }
    await expect(
      app
        .insertInto("app_user")
        .values({ id: newId(KeyPrefix.User), org_id: a.id, email: "x@x.test", name: "X" })
        .execute(),
    ).rejects.toThrow(/row-level security/);
  });

  it("an org sees only its own rows in every tenant table", async () => {
    await withOrg(app, a.id, async (tx) => {
      const orgs = await tx.selectFrom("org").select("id").execute();
      expect(orgs.map((o) => o.id)).toEqual([a.id]);
      for (const table of TENANT_TABLES) {
        const { rows } = await sql<{ org_id: string }>`
          SELECT DISTINCT org_id FROM ${sql.table(table)}
        `.execute(tx);
        // Sessions aren't seeded, so that table may be empty; none may be foreign.
        expect(
          rows.filter((r) => r.org_id !== a.id),
          table,
        ).toEqual([]);
        if (table !== "user_session") expect(rows.length, table).toBe(1);
      }
    });
  });

  it("an org cannot insert a row tagged with another org", async () => {
    await expect(
      withOrg(app, a.id, (tx) =>
        tx
          .insertInto("app_user")
          .values({ id: newId(KeyPrefix.User), org_id: b.id, email: "spy@x.test", name: "Spy" })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("an org cannot move its own row into another org", async () => {
    await expect(
      withOrg(app, a.id, (tx) =>
        tx.updateTable("app_user").set({ org_id: b.id }).where("id", "=", a.userId).execute(),
      ),
    ).rejects.toThrow(/row-level security|foreign key/);
  });

  it("an org cannot link its rows to another org's user", async () => {
    await expect(
      withOrg(app, a.id, (tx) =>
        tx
          .insertInto("user_identity")
          .values({ provider_id: a.providerId, subject: "steal", org_id: a.id, user_id: b.userId })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("updates and deletes aimed at another org's rows touch nothing", async () => {
    await withOrg(app, a.id, async (tx) => {
      const upd = await tx
        .updateTable("app_user")
        .set({ name: "pwned" })
        .where("id", "=", b.userId)
        .executeTakeFirst();
      const del = await tx.deleteFrom("app_user").where("id", "=", b.userId).executeTakeFirst();
      expect(upd.numUpdatedRows).toBe(0n);
      expect(del.numDeletedRows).toBe(0n);
    });
    const still = await admin
      .selectFrom("app_user")
      .select("name")
      .where("id", "=", b.userId)
      .executeTakeFirst();
    expect(still?.name).toBe("Admin");
  });

  it("survives a pooled connection being killed by the server", async () => {
    const errors: Error[] = [];
    const pool = createDb(appUrl ?? "", { max: 1, onIdleError: (e) => errors.push(e) });
    try {
      const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(pool);
      await sql`SELECT pg_terminate_backend(${rows[0]?.pid})`.execute(admin);
      await new Promise((r) => setTimeout(r, 200));
      expect(errors.length).toBe(1); // reported, not thrown
      const again = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(pool);
      expect(again.rows[0]?.ok).toBe(1); // and the pool reconnects
    } finally {
      await pool.destroy();
    }
  });

  it("the org setting does not outlive its transaction on a pooled connection", async () => {
    const single = createDb(appUrl ?? "", { max: 1 });
    try {
      await withOrg(single, a.id, (tx) => tx.selectFrom("app_user").select("id").execute());
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM app_user
      `.execute(single);
      expect(rows[0]?.n).toBe(0);
    } finally {
      await single.destroy();
    }
  });

  it("a failed transaction does not leave the org set either", async () => {
    const single = createDb(appUrl ?? "", { max: 1 });
    try {
      await expect(
        withOrg(single, a.id, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const { rows } = await sql<{ v: string | null }>`SELECT app_org_id() AS v`.execute(single);
      expect(rows[0]?.v).toBeNull();
    } finally {
      await single.destroy();
    }
  });

  it("resolves an org by slug, case-insensitively, without exposing anything else", async () => {
    expect(await resolveOrgBySlug(app, a.slug)).toBe(a.id);
    expect(await resolveOrgBySlug(app, a.slug.toUpperCase())).toBe(a.id);
    expect(await resolveOrgBySlug(app, "no-such-org")).toBeNull();
  });

  describe("session resolution", () => {
    async function makeSession(
      org: Org,
      overrides: { expires?: string; revoked?: boolean; idleFor?: string } = {},
    ): Promise<string> {
      const token = randomBytes(32).toString("base64url");
      await withOrg(app, org.id, (tx) =>
        tx
          .insertInto("user_session")
          .values({
            id: hash(token),
            org_id: org.id,
            user_id: org.userId,
            method: "local",
            expires_at: sql`now() + ${overrides.expires ?? "1 hour"}::interval`,
            last_seen_at: sql`now() - ${overrides.idleFor ?? "0 seconds"}::interval`,
            revoked_at: overrides.revoked ? sql`now()` : null,
          })
          .execute(),
      );
      return token;
    }

    it("returns the org and user for a live session", async () => {
      const token = await makeSession(b);
      expect(await resolveSession(app, hash(token), 120)).toMatchObject({
        orgId: b.id,
        userId: b.userId,
      });
    });

    it("rejects expired, revoked and idle sessions", async () => {
      const expired = await makeSession(a, { expires: "-1 second" });
      const revoked = await makeSession(a, { revoked: true });
      const idle = await makeSession(a, { idleFor: "3 hours" });
      expect(await resolveSession(app, hash(expired), 120)).toBeNull();
      expect(await resolveSession(app, hash(revoked), 120)).toBeNull();
      expect(await resolveSession(app, hash(idle), 120)).toBeNull();
    });

    it("rejects sessions of deactivated users", async () => {
      const token = await makeSession(a);
      await withOrg(app, a.id, (tx) =>
        tx.updateTable("app_user").set({ is_active: false }).where("id", "=", a.userId).execute(),
      );
      try {
        expect(await resolveSession(app, hash(token), 120)).toBeNull();
      } finally {
        await withOrg(app, a.id, (tx) =>
          tx.updateTable("app_user").set({ is_active: true }).where("id", "=", a.userId).execute(),
        );
      }
    });

    it("rejects the raw token: only its hash is stored", async () => {
      const token = await makeSession(a);
      expect(await resolveSession(app, token, 120)).toBeNull();
    });
  });
});
