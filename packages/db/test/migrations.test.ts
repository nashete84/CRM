import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, migrateDown, migrateToLatest } from "../src/index.js";

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;

describe.skipIf(!adminUrl || !appUrl)("migrations", () => {
  const admin = createDb(adminUrl ?? "", { max: 1 });
  const app = createDb(appUrl ?? "", { max: 1 });

  afterAll(async () => {
    await admin.destroy();
    await app.destroy();
  });

  it("apply, roll back and re-apply cleanly", async () => {
    await migrateToLatest(admin);
    await migrateDown(admin);
    const reapplied = await migrateToLatest(admin);
    expect(reapplied.error).toBeUndefined();
  });

  it("leave the app role without superuser or RLS bypass", async () => {
    const { rows } = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `.execute(app);
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
