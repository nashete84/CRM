import {
  MetadataError,
  addPicklistValues,
  createField,
  createObject,
  createRecordType,
  deleteField,
  deleteObject,
  deletePicklistValue,
  deleteRecordType,
  updateField,
  updatePicklistValue,
} from "@crm/metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecord, deleteRecord, getRecord, updateRecord, upsertRecord } from "../src/index.js";
import { type Env, type TestOrg, hasDb, newOrg, setup, teardown } from "./helpers.js";

/** Metadata changes on an object that already has records (DECISIONS.md D-033). */
describe.skipIf(!hasDb)("schema changes with existing records", () => {
  let env: Env;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(() => teardown(env));

  async function refused(p: Promise<unknown>, path?: string): Promise<MetadataError> {
    let caught: unknown;
    try {
      await p;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MetadataError);
    const err = caught as MetadataError;
    expect(err.code).toBe("FIELD_INTEGRITY_EXCEPTION");
    if (path) expect(err.path).toBe(path);
    return err;
  }

  async function withProducts(): Promise<{ org: TestOrg; ids: string[] }> {
    const org = await newOrg(env);
    await org.meta(async (ctx) => {
      await createObject(ctx, { label: "Product", pluralLabel: "Products" });
      await createField(ctx, "Product__c", { type: "Text", label: "SKU", length: 30 });
      await createField(ctx, "Product__c", {
        type: "Currency",
        label: "Price",
        precision: 10,
        scale: 2,
      });
      await createField(ctx, "Product__c", {
        type: "Picklist",
        label: "Family",
        values: ["Hardware", "Software", "Service"],
      });
      await createField(ctx, "Product__c", {
        type: "MultiselectPicklist",
        label: "Regions",
        values: ["EMEA", "AMER", "APAC"],
      });
    });
    const ids: string[] = [];
    await org.run(async (c) => {
      ids.push(
        (
          await createRecord(c, "Product__c", {
            Name: "Laptop",
            SKU__c: "LT-1",
            Price__c: 999.5,
            Family__c: "Hardware",
            Regions__c: "EMEA;APAC",
          })
        ).id,
      );
      ids.push(
        (
          await createRecord(c, "Product__c", {
            Name: "Licence",
            SKU__c: "lt-1",
            Price__c: 50,
            Family__c: "Software",
            Regions__c: "AMER",
          })
        ).id,
      );
      ids.push((await createRecord(c, "Product__c", { Name: "Install", Family__c: "Service" })).id);
    });
    return { org, ids };
  }
  const product = (org: TestOrg, id: string) => org.run((c) => getRecord(c, "Product__c", id));

  it("refuses to make a field required while records lack it, then allows it once filled", async () => {
    const { org, ids } = await withProducts();
    const err = await refused(
      org.meta((ctx) => updateField(ctx, "Product__c", "SKU__c", { required: true })),
      "required",
    );
    expect(err.message).toMatch(/^1 record has no SKU/);
    await org.run((c) => updateRecord(c, "Product__c", ids[2] as string, { SKU__c: "IN-1" }));
    await org.meta((ctx) => updateField(ctx, "Product__c", "SKU__c", { required: true }));
  });

  it("refuses a new required field on an object that has records", async () => {
    const { org } = await withProducts();
    await refused(
      org.meta((ctx) =>
        createField(ctx, "Product__c", { type: "Date", label: "Launch", required: true }),
      ),
      "required",
    );
  });

  it("checks for duplicates before making a field unique, honouring case sensitivity", async () => {
    const { org } = await withProducts();
    // "LT-1" and "lt-1" collide case-insensitively...
    await refused(
      org.meta((ctx) => updateField(ctx, "Product__c", "SKU__c", { unique: true })),
      "unique",
    );
    // ...but not case-sensitively, and then uniqueness is enforced on new records.
    await org.meta((ctx) =>
      updateField(ctx, "Product__c", "SKU__c", {
        unique: true,
        caseSensitive: true,
        externalId: true,
      }),
    );
    const up = await org.run((c) =>
      upsertRecord(c, "Product__c", "SKU__c", "lt-1", { Price__c: 55 }),
    );
    expect(up.created).toBe(false);
    await expect(
      org.run((c) => createRecord(c, "Product__c", { Name: "Dup", SKU__c: "LT-1" })),
    ).rejects.toThrow(/duplicate value/);
    // Turning case sensitivity off now collides again.
    await refused(
      org.meta((ctx) => updateField(ctx, "Product__c", "SKU__c", { caseSensitive: false })),
      "unique",
    );
  });

  it("refuses to shorten text or lose number digits, and reformats on a safe scale change", async () => {
    const { org, ids } = await withProducts();
    await refused(
      org.meta((ctx) => updateField(ctx, "Product__c", "SKU__c", { length: 3 })),
      "length",
    );
    await refused(
      org.meta((ctx) => updateField(ctx, "Product__c", "Price__c", { scale: 0 })),
      "precision",
    ); // 999.50 -> 1000 would lose .5
    await refused(
      org.meta((ctx) => updateField(ctx, "Product__c", "Price__c", { precision: 4, scale: 2 })),
      "precision",
    ); // 999 needs 3 digits, 4-2 = 2
    await org.meta((ctx) => updateField(ctx, "Product__c", "Price__c", { scale: 1 })); // 999.50 -> 999.5 keeps every digit
    const stored = await env.admin
      .selectFrom("record")
      .select("data")
      .where("id", "=", ids[0] as string)
      .executeTakeFirstOrThrow();
    expect(Object.values(stored.data as Record<string, unknown>)).toContain("999.5");
    expect((await product(org, ids[0] as string))?.Price__c).toBe(999.5);
  });

  it("renames picklist values inside records, single and multi-select", async () => {
    const { org, ids } = await withProducts();
    await org.meta((ctx) =>
      updatePicklistValue(ctx, "Product__c", "Family__c", "Hardware", { newValue: "Devices" }),
    );
    await org.meta((ctx) =>
      updatePicklistValue(ctx, "Product__c", "Regions__c", "APAC", { newValue: "Asia" }),
    );
    expect(await product(org, ids[0] as string)).toMatchObject({
      Family__c: "Devices",
      Regions__c: "EMEA;Asia",
    });
  });

  it("replaces or clears a deleted picklist value in records", async () => {
    const { org, ids } = await withProducts();
    const replaced = await org.meta((ctx) =>
      deletePicklistValue(ctx, "Product__c", "Family__c", "Service", { replaceWith: "software" }),
    );
    expect(replaced.recordsChanged).toBe(1);
    expect((await product(org, ids[2] as string))?.Family__c).toBe("Software");
    // Multi-select: EMEA;APAC with APAC -> EMEA collapses to one EMEA.
    await org.meta((ctx) =>
      deletePicklistValue(ctx, "Product__c", "Regions__c", "APAC", { replaceWith: "EMEA" }),
    );
    expect((await product(org, ids[0] as string))?.Regions__c).toBe("EMEA");
    // Without a replacement the value is cleared.
    await org.meta((ctx) => deletePicklistValue(ctx, "Product__c", "Regions__c", "AMER"));
    expect((await product(org, ids[1] as string))?.Regions__c).toBeNull();
  });

  it("keeps multi-select values in picklist order after a replacement", async () => {
    const { org, ids } = await withProducts();
    await org.meta((ctx) => addPicklistValues(ctx, "Product__c", "Regions__c", ["LATAM"]));
    // AMER (2nd in the list) replaced by LATAM (4th): order follows the picklist.
    await org.meta((ctx) =>
      deletePicklistValue(ctx, "Product__c", "Regions__c", "EMEA", { replaceWith: "LATAM" }),
    );
    expect((await product(org, ids[0] as string))?.Regions__c).toBe("APAC;LATAM");
  });

  it("refuses to clear a value from a required picklist without a replacement", async () => {
    const { org } = await withProducts();
    await org.run((c) =>
      createRecord(c, "Product__c", { Name: "Fill", Family__c: "Service" }).then(() => undefined),
    );
    await org.meta((ctx) => updateField(ctx, "Product__c", "Family__c", { required: true }));
    await refused(
      org.meta((ctx) => deletePicklistValue(ctx, "Product__c", "Family__c", "Service")),
      "replaceWith",
    );
  });

  it("refuses to restrict a picklist while records hold other values", async () => {
    const org = await newOrg(env);
    await org.meta(async (ctx) => {
      await createObject(ctx, { label: "Lead Source", pluralLabel: "Lead Sources" });
      await createField(ctx, "Lead_Source__c", {
        type: "Picklist",
        label: "Channel",
        values: ["Web"],
        restricted: false,
      });
    });
    await org.run((c) =>
      createRecord(c, "Lead_Source__c", { Name: "x", Channel__c: "Trade Show" }).then(
        () => undefined,
      ),
    );
    await refused(
      org.meta((ctx) => updateField(ctx, "Lead_Source__c", "Channel__c", { restricted: true })),
      "restricted",
    );
    await org.meta((ctx) => addPicklistValues(ctx, "Lead_Source__c", "Channel__c", ["Trade Show"]));
    await org.meta((ctx) => updateField(ctx, "Lead_Source__c", "Channel__c", { restricted: true }));
  });

  it("needs a replacement to delete a record type in use, even by deleted records", async () => {
    const org = await newOrg(env);
    await org.meta(async (ctx) => {
      await createObject(ctx, { label: "Deal", pluralLabel: "Deals" });
      await createRecordType(ctx, "Deal__c", { label: "New Business" });
      await createRecordType(ctx, "Deal__c", { label: "Renewal" });
    });
    const { id } = await org.run((c) => createRecord(c, "Deal__c", { Name: "d" }));
    await org.run((c) => deleteRecord(c, "Deal__c", id));
    await refused(
      org.meta((ctx) => deleteRecordType(ctx, "Deal__c", "New_Business")),
      "replaceWith",
    );
    const res = await org.meta((ctx) =>
      deleteRecordType(ctx, "Deal__c", "New_Business", { replaceWith: "Renewal" }),
    );
    expect(res.recordsChanged).toBe(1);
  });

  it("refuses a master-detail field once the object has records", async () => {
    const { org } = await withProducts();
    await org.meta((ctx) => createObject(ctx, { label: "Catalog", pluralLabel: "Catalogs" }));
    await refused(
      org.meta((ctx) =>
        createField(ctx, "Product__c", {
          type: "MasterDetail",
          label: "Catalog",
          referenceTo: "Catalog__c",
        }),
      ),
      "type",
    );
  });

  it("numbers existing records when an auto number field is added, oldest first", async () => {
    const { org, ids } = await withProducts();
    await org.meta((ctx) =>
      createField(ctx, "Product__c", {
        type: "AutoNumber",
        label: "Ref",
        displayFormat: "P-{000}",
        startingNumber: 7,
      }),
    );
    const refs = await Promise.all(ids.map(async (id) => (await product(org, id))?.Ref__c));
    expect(refs).toEqual(["P-007", "P-008", "P-009"]);
    const next = await org.run((c) => createRecord(c, "Product__c", { Name: "New" }));
    expect((await product(org, next.id))?.Ref__c).toBe("P-010");
  });

  it("numbers existing records when the Name field becomes an auto number", async () => {
    const { org, ids } = await withProducts();
    await org.meta((ctx) =>
      updateField(ctx, "Product__c", "Name", { type: "AutoNumber", displayFormat: "PRD-{00}" }),
    );
    expect((await product(org, ids[1] as string))?.Name).toBe("PRD-02");
  });

  it("gives existing records a new checkbox's default", async () => {
    const { org, ids } = await withProducts();
    await org.meta((ctx) =>
      createField(ctx, "Product__c", { type: "Checkbox", label: "Sellable", defaultValue: true }),
    );
    expect((await product(org, ids[2] as string))?.Sellable__c).toBe(true);
  });

  it("removes a deleted field's values and index rows", async () => {
    const { org, ids } = await withProducts();
    await org.meta((ctx) => updateField(ctx, "Product__c", "SKU__c", { externalId: true }));
    const fieldId = (
      await env.admin
        .selectFrom("field_def")
        .select("id")
        .where("org_id", "=", org.id)
        .where("api_name", "=", "SKU__c")
        .executeTakeFirstOrThrow()
    ).id;
    await org.meta((ctx) => deleteField(ctx, "Product__c", "SKU__c"));
    const row = await env.admin
      .selectFrom("record")
      .select("data")
      .where("id", "=", ids[0] as string)
      .executeTakeFirstOrThrow();
    expect(Object.keys(row.data as object)).not.toContain(fieldId);
    expect(
      await env.admin
        .selectFrom("record_index")
        .select("record_id")
        .where("field_id", "=", fieldId)
        .execute(),
    ).toEqual([]);
  });

  it("deletes an object with all its records", async () => {
    const { org } = await withProducts();
    await org.meta((ctx) => deleteObject(ctx, "Product__c"));
    const left = await env.admin
      .selectFrom("record")
      .select("id")
      .where("org_id", "=", org.id)
      .execute();
    expect(left).toEqual([]);
  });
});
