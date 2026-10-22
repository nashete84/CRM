import type { Db } from "@crm/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MASTER_RECORD_TYPE_ID,
  type PicklistValueInput,
  addPicklistValues,
  createField,
  createObject,
  createRecordType,
  deletePicklistValue,
  deleteRecordType,
  describeGlobal,
  describeObject,
  picklistValuesForRecordType,
  reorderPicklistValues,
  updatePicklistValue,
  updateRecordType,
} from "../src/index.js";
import { type TestOrg, expectError, hasDb, invoice, newOrg, setup, teardown } from "./helpers.js";

describe.skipIf(!hasDb)("picklists", () => {
  let env: { db: Db; admin: Db; orgs: string[] };
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(() => teardown(env));

  async function withStatus(
    values: unknown[] = ["Draft", { value: "Sent", isDefault: true }, "Paid"],
  ): Promise<TestOrg> {
    const org = await newOrg(env);
    await org.run((ctx) => createObject(ctx, invoice));
    await org.run((ctx) =>
      createField(ctx, "Invoice__c", {
        type: "Picklist",
        label: "Status",
        values: values as PicklistValueInput[],
      }),
    );
    return org;
  }
  const values = async (org: TestOrg) =>
    (await org.run((ctx) => describeObject(ctx, "Invoice__c"))).fields.find(
      (f) => f.name === "Status__c",
    )?.picklistValues;

  it("stores values in order with one default", async () => {
    const org = await withStatus();
    expect(await values(org)).toEqual([
      { value: "Draft", label: "Draft", active: true, defaultValue: false },
      { value: "Sent", label: "Sent", active: true, defaultValue: true },
      { value: "Paid", label: "Paid", active: true, defaultValue: false },
    ]);
  });

  it.each<[string, unknown[], string]>([
    ["no values", [], "INVALID_FIELD"],
    ["duplicates differing only in case", ["Open", "OPEN"], "DUPLICATE_DEVELOPER_NAME"],
    [
      "two defaults",
      [
        { value: "A", isDefault: true },
        { value: "B", isDefault: true },
      ],
      "INVALID_FIELD",
    ],
    ["a blank value", ["A", "  "], "INVALID_FIELD"],
    ["a value over 255 characters", ["x".repeat(256)], "INVALID_FIELD"],
  ])("rejects %s", async (_why, list, code) => {
    const org = await newOrg(env);
    await org.run((ctx) => createObject(ctx, invoice));
    await expectError(
      org.run((ctx) =>
        createField(ctx, "Invoice__c", {
          type: "Picklist",
          label: "Status",
          values: list as PicklistValueInput[],
        }),
      ),
      code as "INVALID_FIELD",
    );
  });

  it("refuses ; in multi-select values, which separates selections", async () => {
    const org = await newOrg(env);
    await org.run((ctx) => createObject(ctx, invoice));
    await expectError(
      org.run((ctx) =>
        createField(ctx, "Invoice__c", {
          type: "MultiselectPicklist",
          label: "Tags",
          values: ["a;b"],
        }),
      ),
      "INVALID_FIELD",
    );
  });

  it("adds, renames, relabels, reorders, deactivates and deletes values", async () => {
    const org = await withStatus();
    await org.run((ctx) =>
      addPicklistValues(ctx, "Invoice__c", "Status__c", [{ value: "Void", isDefault: true }]),
    );
    await expectError(
      org.run((ctx) => addPicklistValues(ctx, "Invoice__c", "Status__c", ["draft"])),
      "DUPLICATE_DEVELOPER_NAME",
    );
    await org.run((ctx) =>
      updatePicklistValue(ctx, "Invoice__c", "Status__c", "Paid", {
        newValue: "Settled",
        label: "Settled in full",
      }),
    );
    await org.run((ctx) =>
      reorderPicklistValues(ctx, "Invoice__c", "Status__c", ["Void", "Settled"]),
    );
    await org.run((ctx) =>
      updatePicklistValue(ctx, "Invoice__c", "Status__c", "Void", { isActive: false }),
    );
    await org.run((ctx) => deletePicklistValue(ctx, "Invoice__c", "Status__c", "draft"));
    expect(await values(org)).toEqual([
      { value: "Void", label: "Void", active: false, defaultValue: false }, // deactivating cleared the default
      { value: "Settled", label: "Settled in full", active: true, defaultValue: false },
      { value: "Sent", label: "Sent", active: true, defaultValue: false },
    ]);
  });

  it("keeps at least one active value, and only active values as default", async () => {
    const org = await withStatus(["Only"]);
    await expectError(
      org.run((ctx) =>
        updatePicklistValue(ctx, "Invoice__c", "Status__c", "Only", { isActive: false }),
      ),
      "INVALID_FIELD",
    );
    await expectError(
      org.run((ctx) => deletePicklistValue(ctx, "Invoice__c", "Status__c", "Only")),
      "CANNOT_DELETE",
    );
    await org.run((ctx) => addPicklistValues(ctx, "Invoice__c", "Status__c", ["Old"]));
    await org.run((ctx) =>
      updatePicklistValue(ctx, "Invoice__c", "Status__c", "Old", { isActive: false }),
    );
    await expectError(
      org.run((ctx) =>
        updatePicklistValue(ctx, "Invoice__c", "Status__c", "Old", { isDefault: true }),
      ),
      "INVALID_FIELD",
    );
  });

  describe("record types", () => {
    it("offers a subset of values with its own default", async () => {
      const org = await withStatus();
      await org.run((ctx) =>
        createRecordType(ctx, "Invoice__c", {
          label: "Credit Note",
          picklists: { Status__c: { values: ["draft", "Paid"], default: "Paid" } },
        }),
      );
      const offered = await org.run((ctx) =>
        picklistValuesForRecordType(ctx, "Invoice__c", "Status__c", "Credit_Note"),
      );
      expect(offered.values.map((v) => v.value)).toEqual(["Draft", "Paid"]);
      expect(offered.defaultValue).toBe("Paid");
      const master = await org.run((ctx) =>
        picklistValuesForRecordType(ctx, "Invoice__c", "Status__c", "Master"),
      );
      expect(master.values.map((v) => v.value)).toEqual(["Draft", "Sent", "Paid"]);
      expect(master.defaultValue).toBe("Sent");
    });

    it("adds RecordTypeId and record type infos to describe", async () => {
      const org = await withStatus();
      let d = await org.run((ctx) => describeObject(ctx, "Invoice__c"));
      expect(d.fields.some((f) => f.name === "RecordTypeId")).toBe(false);
      expect(d.recordTypeInfos).toEqual([
        expect.objectContaining({
          recordTypeId: MASTER_RECORD_TYPE_ID,
          master: true,
          defaultRecordTypeMapping: true,
        }),
      ]);
      const rt = await org.run((ctx) => createRecordType(ctx, "Invoice__c", { label: "Standard" }));
      d = await org.run((ctx) => describeObject(ctx, "Invoice__c"));
      expect(d.fields.find((f) => f.name === "RecordTypeId")).toMatchObject({
        referenceTo: ["RecordType"],
        nillable: true,
      });
      expect(d.recordTypeInfos.map((r) => [r.developerName, r.defaultRecordTypeMapping])).toEqual([
        ["Standard", true],
        ["Master", false],
      ]);
      expect(d.recordTypeInfos[0]?.recordTypeId).toBe(rt.id);
    });

    it("gives new record types every active value, and new values every record type", async () => {
      const org = await withStatus();
      await org.run((ctx) => createRecordType(ctx, "Invoice__c", { label: "Standard" }));
      await org.run((ctx) => addPicklistValues(ctx, "Invoice__c", "Status__c", ["Disputed"]));
      await org.run((ctx) =>
        addPicklistValues(ctx, "Invoice__c", "Status__c", ["Internal"], {
          addToRecordTypes: false,
        }),
      );
      const offered = await org.run((ctx) =>
        picklistValuesForRecordType(ctx, "Invoice__c", "Status__c", "Standard"),
      );
      expect(offered.values.map((v) => v.value)).toEqual(["Draft", "Sent", "Paid", "Disputed"]);
      expect(offered.defaultValue).toBe("Sent");
    });

    it("follows renames and drops deactivated values from what it offers", async () => {
      const org = await withStatus();
      await org.run((ctx) =>
        createRecordType(ctx, "Invoice__c", {
          label: "Standard",
          picklists: { Status__c: { values: ["Sent", "Paid"], default: "Paid" } },
        }),
      );
      await org.run((ctx) =>
        updatePicklistValue(ctx, "Invoice__c", "Status__c", "Paid", { newValue: "Settled" }),
      );
      await org.run((ctx) =>
        updatePicklistValue(ctx, "Invoice__c", "Status__c", "Sent", { isActive: false }),
      );
      const offered = await org.run((ctx) =>
        picklistValuesForRecordType(ctx, "Invoice__c", "Status__c", "Standard"),
      );
      expect(offered).toEqual({
        values: [expect.objectContaining({ value: "Settled", defaultValue: true })],
        defaultValue: "Settled",
      });
    });

    it("rejects unknown fields and values, misplaced defaults and reserved names", async () => {
      const org = await withStatus();
      await expectError(
        org.run((ctx) =>
          createRecordType(ctx, "Invoice__c", {
            label: "A",
            picklists: { Nope__c: { values: ["Draft"] } },
          }),
        ),
        "NOT_FOUND",
      );
      await expectError(
        org.run((ctx) =>
          createRecordType(ctx, "Invoice__c", {
            label: "B",
            picklists: { Status__c: { values: ["Lost"] } },
          }),
        ),
        "INVALID_FIELD",
      );
      await expectError(
        org.run((ctx) =>
          createRecordType(ctx, "Invoice__c", {
            label: "C",
            picklists: { Status__c: { values: ["Draft"], default: "Paid" } },
          }),
        ),
        "INVALID_FIELD",
      );
      await expectError(
        org.run((ctx) =>
          createRecordType(ctx, "Invoice__c", {
            label: "D",
            picklists: { Status__c: { values: [] } },
          }),
        ),
        "INVALID_FIELD",
      );
      await expectError(
        org.run((ctx) => createRecordType(ctx, "Invoice__c", { label: "Master" })),
        "INVALID_NAME",
      );
      await org.run((ctx) => createRecordType(ctx, "Invoice__c", { label: "Retail" }));
      await expectError(
        org.run((ctx) =>
          createRecordType(ctx, "Invoice__c", { label: "Other", developerName: "RETAIL" }),
        ),
        "DUPLICATE_DEVELOPER_NAME",
      );
      await expectError(
        org.run((ctx) => createRecordType(ctx, "User", { label: "Staff" })),
        "NOT_SUPPORTED",
      );
    });

    it("updates, deactivates and deletes", async () => {
      const org = await withStatus();
      await org.run((ctx) => createRecordType(ctx, "Invoice__c", { label: "Retail" }));
      await org.run((ctx) =>
        updateRecordType(ctx, "Invoice__c", "Retail", {
          label: "Retail Sale",
          isActive: false,
          picklists: { Status__c: { values: ["Draft"] } },
        }),
      );
      let d = await org.run((ctx) => describeObject(ctx, "Invoice__c"));
      expect(d.recordTypeInfos[0]).toMatchObject({
        name: "Retail Sale",
        active: false,
        defaultRecordTypeMapping: false,
      });
      expect(d.recordTypeInfos[1]).toMatchObject({ master: true, defaultRecordTypeMapping: true });
      await org.run((ctx) => deleteRecordType(ctx, "Invoice__c", "Retail"));
      d = await org.run((ctx) => describeObject(ctx, "Invoice__c"));
      expect(d.recordTypeInfos).toHaveLength(1);
    });
  });
});

describe.skipIf(!hasDb)("metadata isolation", () => {
  let env: { db: Db; admin: Db; orgs: string[] };
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(() => teardown(env));

  it("an org can't see, use or point at another org's objects", async () => {
    const a = await newOrg(env, "alpha");
    const b = await newOrg(env, "bravo");
    await a.run((ctx) => createObject(ctx, { label: "Secret", pluralLabel: "Secrets" }));
    await b.run((ctx) => createObject(ctx, invoice));

    expect((await b.run((ctx) => describeGlobal(ctx))).map((o) => o.name)).toEqual([
      "Invoice__c",
      "User",
    ]);
    await expectError(
      b.run((ctx) => describeObject(ctx, "Secret__c")),
      "NOT_FOUND",
    );
    await expectError(
      b.run((ctx) =>
        createField(ctx, "Invoice__c", { type: "Lookup", label: "Leak", referenceTo: "Secret__c" }),
      ),
      "NOT_FOUND",
      "referenceTo",
    );
    // Both orgs get key prefix a00 for their first object: prefixes are per org.
    const prefixes = await env.admin
      .selectFrom("object_def")
      .select("key_prefix")
      .where("org_id", "in", [a.id, b.id])
      .where("is_custom", "=", true)
      .execute();
    expect(prefixes.map((p) => p.key_prefix)).toEqual(["a00", "a00"]);
  });
});
