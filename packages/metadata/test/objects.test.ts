import type { Db } from "@crm/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LIMITS,
  createField,
  createObject,
  deleteObject,
  describeGlobal,
  describeObject,
  updateField,
  updateObject,
} from "../src/index.js";
import { type TestOrg, expectError, hasDb, invoice, newOrg, setup, teardown } from "./helpers.js";

describe.skipIf(!hasDb)("objects", () => {
  let env: { db: Db; admin: Db; orgs: string[] };
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(() => teardown(env));

  it("creates a custom object with a Name field and the next key prefix", async () => {
    const org = await newOrg(env);
    const first = await org.run((ctx) => createObject(ctx, invoice));
    const second = await org.run((ctx) =>
      createObject(ctx, { label: "Invoice Line", pluralLabel: "Invoice Lines" }),
    );
    expect(first).toMatchObject({
      api_name: "Invoice__c",
      key_prefix: "a00",
      is_custom: true,
      sharing_model: "ReadWrite",
    });
    expect(second).toMatchObject({ api_name: "Invoice_Line__c", key_prefix: "a01" });
    const d = await org.run((ctx) => describeObject(ctx, "invoice__C"));
    const name = d.fields.find((f) => f.name === "Name");
    expect(name).toMatchObject({
      label: "Invoice Name",
      type: "string",
      length: 80,
      nameField: true,
      nillable: false,
    });
  });

  it("can number records automatically from the Name field", async () => {
    const org = await newOrg(env);
    await org.run((ctx) =>
      createObject(ctx, {
        ...invoice,
        nameField: {
          label: "Invoice Number",
          type: "AutoNumber",
          displayFormat: "INV-{YYYY}-{0000}",
        },
      }),
    );
    const name = (await org.run((ctx) => describeObject(ctx, "Invoice__c"))).fields.find(
      (f) => f.nameField,
    );
    expect(name).toMatchObject({
      autoNumber: true,
      createable: false,
      updateable: false,
      type: "string",
    });
    await expectError(
      org.run((ctx) =>
        createObject(ctx, { label: "Bad", pluralLabel: "Bads", nameField: { type: "AutoNumber" } }),
      ),
      "INVALID_FIELD",
      "nameField.displayFormat",
    );
  });

  it("switches the Name field between Text and Auto Number", async () => {
    const org = await newOrg(env);
    await org.run((ctx) => createObject(ctx, invoice));
    await org.run((ctx) =>
      updateField(ctx, "Invoice__c", "Name", { type: "AutoNumber", displayFormat: "INV-{0000}" }),
    );
    let name = (await org.run((ctx) => describeObject(ctx, "Invoice__c"))).fields.find(
      (f) => f.nameField,
    );
    expect(name?.autoNumber).toBe(true);
    await org.run((ctx) => updateField(ctx, "Invoice__c", "Name", { type: "Text" }));
    name = (await org.run((ctx) => describeObject(ctx, "Invoice__c"))).fields.find(
      (f) => f.nameField,
    );
    expect(name).toMatchObject({ autoNumber: false, length: 80 });
    await expectError(
      org.run((ctx) => updateField(ctx, "Invoice__c", "Name", { length: 81 })),
      "INVALID_FIELD",
      "length",
    );
  });

  it("refuses duplicate API names, ignoring case", async () => {
    const org = await newOrg(env);
    await org.run((ctx) => createObject(ctx, invoice));
    await expectError(
      org.run((ctx) =>
        createObject(ctx, { apiName: "INVOICE", label: "Other", pluralLabel: "Others" }),
      ),
      "DUPLICATE_DEVELOPER_NAME",
    );
  });

  it("refuses names that clash with a built-in object only if exactly equal", async () => {
    const org = await newOrg(env);
    // User__c is a different API name from the built-in User, as in Salesforce.
    const custom = await org.run((ctx) =>
      createObject(ctx, { apiName: "User", label: "User", pluralLabel: "Users" }),
    );
    expect(custom.api_name).toBe("User__c");
  });

  it("validates labels, description and sharing model", async () => {
    const org = await newOrg(env);
    await expectError(
      org.run((ctx) => createObject(ctx, { label: "", pluralLabel: "X" })),
      "INVALID_FIELD",
      "label",
    );
    await expectError(
      org.run((ctx) => createObject(ctx, { label: "A".repeat(41), pluralLabel: "X" })),
      "INVALID_FIELD",
      "label",
    );
    await expectError(
      org.run((ctx) => createObject(ctx, { ...invoice, description: "x".repeat(1001) })),
      "INVALID_FIELD",
      "description",
    );
    await expectError(
      org.run((ctx) =>
        createObject(ctx, { ...invoice, sharingModel: "ControlledByParent" as never }),
      ),
      "INVALID_FIELD",
      "sharingModel",
    );
  });

  it("renames and relabels, and rejects unknown properties", async () => {
    const org = await newOrg(env);
    await org.run((ctx) => createObject(ctx, invoice));
    const renamed = await org.run((ctx) =>
      updateObject(ctx, "Invoice__c", {
        apiName: "Bill",
        label: "Bill",
        pluralLabel: "Bills",
        sharingModel: "Private",
      }),
    );
    expect(renamed).toMatchObject({ api_name: "Bill__c", label: "Bill", sharing_model: "Private" });
    await expectError(
      org.run((ctx) => updateObject(ctx, "Bill__c", { keyPrefix: "zzz" } as never)),
      "INVALID_FIELD",
      "keyPrefix",
    );
  });

  it("keeps the built-in User object read-only", async () => {
    const org = await newOrg(env);
    await expectError(
      org.run((ctx) => updateObject(ctx, "User", { label: "Person" })),
      "NOT_SUPPORTED",
    );
    await expectError(
      org.run((ctx) => createField(ctx, "User", { type: "Text", label: "Badge" })),
      "NOT_SUPPORTED",
    );
    await expectError(
      org.run((ctx) => deleteObject(ctx, "User")),
      "CANNOT_DELETE",
    );
    const user = await org.run((ctx) => describeObject(ctx, "User"));
    expect(user.fields.map((f) => f.name)).toEqual([
      "Id",
      "Name",
      "Email",
      "IsActive",
      "TimeZoneSidKey",
      "LanguageLocaleKey",
    ]);
    expect(user).toMatchObject({ keyPrefix: "005", custom: false, createable: false });
  });

  it("deletes a custom object with everything on it", async () => {
    const org = await newOrg(env);
    await org.run((ctx) => createObject(ctx, invoice));
    await org.run((ctx) =>
      createField(ctx, "Invoice__c", {
        type: "Picklist",
        label: "Status",
        values: ["Draft", "Sent"],
      }),
    );
    await org.run((ctx) => deleteObject(ctx, "Invoice__c"));
    const names = (await org.run((ctx) => describeGlobal(ctx))).map((o) => o.name);
    expect(names).toEqual(["User"]);
    const leftovers = await env.admin
      .selectFrom("field_def")
      .select("id")
      .where("org_id", "=", org.id)
      .execute();
    expect(leftovers.length).toBe(5); // only User's fields remain
  });

  it("refuses to delete an object other objects point to, and says which fields", async () => {
    const org = await newOrg(env);
    await org.run((ctx) =>
      createObject(ctx, { label: "Account", pluralLabel: "Accounts", apiName: "Client" }),
    );
    await org.run((ctx) => createObject(ctx, invoice));
    await org.run((ctx) =>
      createField(ctx, "Invoice__c", { type: "Lookup", label: "Client", referenceTo: "Client__c" }),
    );
    const err = await expectError(
      org.run((ctx) => deleteObject(ctx, "Client__c")),
      "CANNOT_DELETE",
    );
    expect(err.message).toContain("Invoice__c.Client__c");
  });

  it("deletes an object that only points to itself", async () => {
    const org = await newOrg(env);
    await org.run((ctx) => createObject(ctx, { label: "Region", pluralLabel: "Regions" }));
    await org.run((ctx) =>
      createField(ctx, "Region__c", {
        type: "Lookup",
        label: "Parent Region",
        referenceTo: "Region__c",
        relationshipName: "Subregions",
      }),
    );
    await org.run((ctx) => deleteObject(ctx, "Region__c"));
  });

  it("lets a whole org be deleted, relationships and all", async () => {
    const org = await newOrg(env);
    await org.run((ctx) => createObject(ctx, { label: "Client", pluralLabel: "Clients" }));
    await org.run((ctx) => createObject(ctx, invoice));
    await org.run((ctx) =>
      createField(ctx, "Invoice__c", {
        type: "MasterDetail",
        label: "Client",
        referenceTo: "Client__c",
      }),
    );
    await org.run((ctx) =>
      createField(ctx, "Invoice__c", { type: "Lookup", label: "Approver", referenceTo: "User" }),
    );
    await env.admin.deleteFrom("org").where("id", "=", org.id).execute();
    const left = await env.admin
      .selectFrom("object_def")
      .select("id")
      .where("org_id", "=", org.id)
      .execute();
    expect(left).toEqual([]);
  });

  it(`stops at ${LIMITS.customObjectsPerOrg} custom objects`, async () => {
    const org = await newOrg(env);
    await org.run(async (ctx) => {
      for (let i = 0; i < LIMITS.customObjectsPerOrg; i++) {
        await createObject(ctx, {
          apiName: `Obj${i}`,
          label: `Obj ${i}`,
          pluralLabel: `Objs ${i}`,
        });
      }
    });
    await expectError(
      org.run((ctx) => createObject(ctx, invoice)),
      "LIMIT_EXCEEDED",
    );
  });

  it("bumps the org's metadata version on every change", async () => {
    const org = await newOrg(env);
    const version = async () =>
      Number(
        (
          await env.admin
            .selectFrom("org")
            .select("metadata_version")
            .where("id", "=", org.id)
            .executeTakeFirstOrThrow()
        ).metadata_version,
      );
    const before = await version();
    await org.run((ctx) => createObject(ctx, invoice));
    const afterCreate = await version();
    await org.run((ctx) => updateObject(ctx, "Invoice__c", { label: "Bill" }));
    expect(afterCreate).toBeGreaterThan(before);
    expect(await version()).toBeGreaterThan(afterCreate);
  });
});
