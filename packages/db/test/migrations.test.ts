import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, createDb, migrateDown, migrateToLatest } from "../src/index.js";

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

describe.skipIf(!adminUrl || !appUrl)("migrations", () => {
  // Rolling migrations back drops tables, so it runs in a throwaway database
  // instead of the one the other test files are using at the same time.
  const scratchName = `crm_migtest_${randomBytes(4).toString("hex")}`;
  const admin = createDb(adminUrl ?? "", { max: 1 });
  let scratch: Db;

  beforeAll(async () => {
    await sql.raw(`CREATE DATABASE ${scratchName}`).execute(admin);
    await sql.raw(`GRANT CONNECT ON DATABASE ${scratchName} TO crm_app`).execute(admin);
    // Dropping the scratch database cuts this pool's connection; that's expected.
    scratch = createDb(withDatabase(adminUrl ?? "", scratchName), {
      max: 1,
      onIdleError: () => {},
    });
  });

  afterAll(async () => {
    await scratch?.destroy();
    await sql.raw(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).execute(admin);
    await admin.destroy();
  });

  it("apply, roll back one by one, and re-apply cleanly", async () => {
    const first = await migrateToLatest(scratch);
    const applied = first.results?.length ?? 0;
    expect(applied).toBeGreaterThan(0);
    for (let i = 0; i < applied; i++) await migrateDown(scratch);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE 'kysely_%'
    `.execute(scratch);
    expect(rows[0]?.n).toBe(0);
    const again = await migrateToLatest(scratch);
    expect(again.results?.length).toBe(applied);
  });

  it("leave the app role without superuser or RLS bypass", async () => {
    const app = createDb(appUrl ?? "", { max: 1 });
    try {
      const { rows } = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `.execute(app);
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    } finally {
      await app.destroy();
    }
  });
});
