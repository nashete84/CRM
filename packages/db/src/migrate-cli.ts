import { createDb, migrateDown, migrateToLatest } from "./index.js";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL is not set. Migrations run as the owner role.");
  process.exit(1);
}

const direction = process.argv[2] ?? "latest";
const db = createDb(url, { max: 1 });

try {
  const result = direction === "down" ? await migrateDown(db) : await migrateToLatest(db);
  const applied = result.results ?? [];
  if (applied.length === 0) console.log("Database is up to date.");
  for (const r of applied) console.log(`${r.status}: ${r.migrationName} (${r.direction})`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
