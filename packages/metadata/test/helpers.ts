import { randomBytes } from "node:crypto";
import {
  type Db,
  KeyPrefix,
  createDb,
  ensurePlatformObjects,
  migrateToLatest,
  newId,
  withOrg,
} from "@crm/db";
import { expect } from "vitest";
import { type Ctx, MetadataError, type MetadataErrorCode } from "../src/index.js";

export const adminUrl = process.env.DATABASE_ADMIN_URL;
export const appUrl = process.env.DATABASE_URL;
export const hasDb = Boolean(adminUrl && appUrl);

export type TestOrg = {
  id: string;
  /** Runs fn in its own org-scoped transaction, committed on success. */
  run: <T>(fn: (ctx: Ctx) => Promise<T>) => Promise<T>;
};

export async function setup(): Promise<{ db: Db; admin: Db; orgs: string[] }> {
  const admin = createDb(adminUrl ?? "", { max: 1 });
  await migrateToLatest(admin);
  return { db: createDb(appUrl ?? "", { max: 5 }), admin, orgs: [] };
}

export async function newOrg(env: { db: Db; orgs: string[] }, label = "meta"): Promise<TestOrg> {
  const id = newId(KeyPrefix.Org);
  await withOrg(env.db, id, async (tx) => {
    await tx
      .insertInto("org")
      .values({ id, name: label, slug: `${label}-${randomBytes(4).toString("hex")}` })
      .execute();
    await ensurePlatformObjects(tx, id);
  });
  env.orgs.push(id);
  return { id, run: (fn) => withOrg(env.db, id, (tx) => fn({ tx, orgId: id })) };
}

export async function teardown(env: { db: Db; admin: Db; orgs: string[] }): Promise<void> {
  if (env.orgs.length) await env.admin.deleteFrom("org").where("id", "in", env.orgs).execute();
  await env.admin.destroy();
  await env.db.destroy();
}

/** Asserts the promise fails with a MetadataError of this code (and optionally path). */
export async function expectError(
  promise: Promise<unknown>,
  code: MetadataErrorCode,
  path?: string,
): Promise<MetadataError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected a MetadataError").toBeInstanceOf(MetadataError);
  const err = caught as MetadataError;
  expect({ code: err.code, message: err.message }).toMatchObject({ code });
  if (path !== undefined) expect(err.path).toBe(path);
  return err;
}

/** A custom object with just a Name field. */
export const invoice = { label: "Invoice", pluralLabel: "Invoices" };
