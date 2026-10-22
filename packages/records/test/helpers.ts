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
import { type Ctx, createField, createObject } from "@crm/metadata";
import { expect } from "vitest";
import { type RecordCtx, RecordError, type RecordStatusCode } from "../src/index.js";

export const hasDb = Boolean(process.env.DATABASE_ADMIN_URL && process.env.DATABASE_URL);

export type Env = { db: Db; admin: Db; orgs: string[] };

export type TestOrg = {
  id: string;
  userId: string;
  /** Runs fn in its own org-scoped transaction as the org's first user. */
  run: <T>(fn: (ctx: RecordCtx) => Promise<T>) => Promise<T>;
  /** Same, for metadata calls. */
  meta: <T>(fn: (ctx: Ctx) => Promise<T>) => Promise<T>;
  addUser: (opts?: { active?: boolean }) => Promise<string>;
};

export async function setup(): Promise<Env> {
  const admin = createDb(process.env.DATABASE_ADMIN_URL ?? "", { max: 1 });
  await migrateToLatest(admin);
  return { db: createDb(process.env.DATABASE_URL ?? "", { max: 5 }), admin, orgs: [] };
}

export async function teardown(env: Env): Promise<void> {
  if (env.orgs.length) await env.admin.deleteFrom("org").where("id", "in", env.orgs).execute();
  await env.admin.destroy();
  await env.db.destroy();
}

export async function newOrg(env: Env): Promise<TestOrg> {
  const id = newId(KeyPrefix.Org);
  const addUser = async ({ active = true }: { active?: boolean } = {}) => {
    const userId = newId(KeyPrefix.User);
    await withOrg(env.db, id, (tx) =>
      tx
        .insertInto("app_user")
        .values({ id: userId, org_id: id, email: `${userId}@t.test`, name: "U", is_active: active })
        .execute(),
    );
    return userId;
  };
  await withOrg(env.db, id, async (tx) => {
    await tx
      .insertInto("org")
      .values({ id, name: "t", slug: `rec-${randomBytes(4).toString("hex")}` })
      .execute();
    await ensurePlatformObjects(tx, id);
  });
  env.orgs.push(id);
  const userId = await addUser();
  return {
    id,
    userId,
    run: (fn) => withOrg(env.db, id, (tx) => fn({ tx, orgId: id, userId })),
    meta: (fn) => withOrg(env.db, id, (tx) => fn({ tx, orgId: id })),
    addUser,
  };
}

/** Asserts the promise fails with a RecordError whose first status code is this one. */
export async function expectRecordError(
  promise: Promise<unknown>,
  statusCode: RecordStatusCode,
  fields?: string[],
): Promise<RecordError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected a RecordError").toBeInstanceOf(RecordError);
  const err = caught as RecordError;
  expect(err.errors.map((e) => e.statusCode)).toContain(statusCode);
  if (fields) expect(err.errors.find((e) => e.statusCode === statusCode)?.fields).toEqual(fields);
  return err;
}

/** Account-like parent, Invoice detail, Line detail-of-detail, and a lookup-holding Note. */
export async function salesModel(org: TestOrg): Promise<void> {
  await org.meta(async (ctx) => {
    await createObject(ctx, { label: "Client", pluralLabel: "Clients" });
    await createField(ctx, "Client__c", {
      type: "Text",
      label: "Code",
      unique: true,
      externalId: true,
      length: 20,
    });
    await createField(ctx, "Client__c", {
      type: "Lookup",
      label: "Parent",
      referenceTo: "Client__c",
      relationshipName: "Subsidiaries",
    });
    await createObject(ctx, {
      label: "Invoice",
      pluralLabel: "Invoices",
      nameField: {
        label: "Invoice Number",
        type: "AutoNumber",
        displayFormat: "INV-{0000}",
        startingNumber: 100,
      },
    });
    await createField(ctx, "Invoice__c", {
      type: "MasterDetail",
      label: "Client",
      referenceTo: "Client__c",
    });
    await createField(ctx, "Invoice__c", { type: "Currency", label: "Total" });
    await createField(ctx, "Invoice__c", { type: "Date", label: "Due Date" });
    await createField(ctx, "Invoice__c", { type: "Checkbox", label: "Paid" });
    await createField(ctx, "Invoice__c", {
      type: "Picklist",
      label: "Status",
      values: ["Draft", { value: "Sent", isDefault: true }, "Paid"],
    });
    await createObject(ctx, { label: "Line", pluralLabel: "Lines" });
    await createField(ctx, "Line__c", {
      type: "MasterDetail",
      label: "Invoice",
      referenceTo: "Invoice__c",
    });
    await createField(ctx, "Line__c", {
      type: "Number",
      label: "Quantity",
      precision: 6,
      scale: 0,
    });
    await createObject(ctx, { label: "Note", pluralLabel: "Notes" });
    await createField(ctx, "Note__c", {
      type: "Lookup",
      label: "Client",
      referenceTo: "Client__c",
      relationshipName: "Notes",
    });
    await createField(ctx, "Note__c", {
      type: "Lookup",
      label: "Pinned Invoice",
      referenceTo: "Invoice__c",
      relationshipName: "PinnedNotes",
      required: true,
    });
    await createField(ctx, "Note__c", { type: "Lookup", label: "Reviewer", referenceTo: "User" });
  });
}
