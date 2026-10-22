import type { Db } from "@crm/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type FieldInput,
  LIMITS,
  createField,
  createObject,
  deleteField,
  describeObject,
  updateField,
} from "../src/index.js";
import { type TestOrg, expectError, hasDb, invoice, newOrg, setup, teardown } from "./helpers.js";

describe.skipIf(!hasDb)("fields", () => {
  let env: { db: Db; admin: Db; orgs: string[] };
  let org: TestOrg;

  const add = (input: FieldInput) => org.run((ctx) => createField(ctx, "Invoice__c", input));
  const field = async (name: string) =>
    (await org.run((ctx) => describeObject(ctx, "Invoice__c"))).fields.find((f) => f.name === name);

  beforeAll(async () => {
    env = await setup();
    org = await newOrg(env);
    await org.run((ctx) => createObject(ctx, invoice));
  });
  afterAll(() => teardown(env));

  it("creates every field type and describes it in Salesforce terms", async () => {
    const cases: [FieldInput, Record<string, unknown>][] = [
      [
        { type: "Text", label: "PO Number", length: 40 },
        { name: "PO_Number__c", type: "string", length: 40 },
      ],
      [
        { type: "TextArea", label: "Notes" },
        { type: "textarea", length: 255 },
      ],
      [
        { type: "LongTextArea", label: "Terms", length: 5000, visibleLines: 6 },
        { type: "textarea", length: 5000, extraTypeInfo: "plaintextarea" },
      ],
      [
        { type: "Email", label: "Billing Email" },
        { type: "email", length: 80 },
      ],
      [{ type: "Phone", label: "Billing Phone" }, { type: "phone" }],
      [{ type: "Url", label: "Portal Link" }, { type: "url" }],
      [
        { type: "Number", label: "Quantity", precision: 10, scale: 0 },
        { type: "double", precision: 10, scale: 0 },
      ],
      [
        { type: "Currency", label: "Total" },
        { type: "currency", precision: 18, scale: 2 },
      ],
      [
        { type: "Percent", label: "Discount", precision: 5, scale: 2 },
        { type: "percent", precision: 5, scale: 2 },
      ],
      [
        { type: "Checkbox", label: "Paid", defaultValue: true },
        { type: "boolean", nillable: false, defaultValue: true },
      ],
      [
        { type: "Date", label: "Due Date", required: true },
        { type: "date", nillable: false },
      ],
      [{ type: "DateTime", label: "Sent At" }, { type: "datetime" }],
      [
        { type: "AutoNumber", label: "Ref", displayFormat: "R-{000}" },
        { type: "string", autoNumber: true, createable: false },
      ],
    ];
    for (const [input, expected] of cases) {
      await add(input);
      const name = input.apiName ?? `${input.label.replace(/ /g, "_")}__c`;
      expect(await field(name), input.label).toMatchObject({ custom: true, ...expected });
    }
  });

  it.each<[string, FieldInput, string]>([
    ["text too long", { type: "Text", label: "T1", length: 256 }, "length"],
    ["text length zero", { type: "Text", label: "T2", length: 0 }, "length"],
    ["long text too short", { type: "LongTextArea", label: "T3", length: 255 }, "length"],
    ["long text too long", { type: "LongTextArea", label: "T4", length: 131073 }, "length"],
    [
      "visible lines out of range",
      { type: "LongTextArea", label: "T5", visibleLines: 51 },
      "visibleLines",
    ],
    ["precision over 18", { type: "Number", label: "N1", precision: 19 }, "precision"],
    ["scale not below precision", { type: "Number", label: "N2", precision: 4, scale: 4 }, "scale"],
    ["fractional precision", { type: "Number", label: "N3", precision: 4.5 }, "precision"],
    ["setting from another type", { type: "Email", label: "E1", length: 10 }, "length"],
    ["misspelt setting", { type: "Text", label: "T6", lenght: 10 }, "lenght"],
    [
      "bad auto number format",
      { type: "AutoNumber", label: "A1", displayFormat: "R-" },
      "displayFormat",
    ],
  ])("rejects %s", async (_why, input, path) => {
    await expectError(add(input), "INVALID_FIELD", path);
  });

  it.each<[string, FieldInput, string]>([
    ["required checkbox", { type: "Checkbox", label: "C1", required: true }, "required"],
    [
      "required auto number",
      { type: "AutoNumber", label: "A2", displayFormat: "{0}", required: true },
      "required",
    ],
    ["unique phone", { type: "Phone", label: "P1", unique: true }, "unique"],
    ["unique currency", { type: "Currency", label: "C2", unique: true }, "unique"],
    ["external ID date", { type: "Date", label: "D1", externalId: true }, "externalId"],
    [
      "case-sensitive but not unique",
      { type: "Text", label: "T7", caseSensitive: true },
      "caseSensitive",
    ],
    [
      "relationship settings on a text field",
      { type: "Text", label: "T8", referenceTo: "User" },
      "referenceTo",
    ],
    ["picklist values on a text field", { type: "Text", label: "T9", values: ["a"] }, "values"],
  ])("refuses %s", async (_why, input, path) => {
    await expectError(add(input), "INVALID_FIELD", path);
  });

  it("allows unique, case-sensitive external IDs where Salesforce does", async () => {
    await add({
      type: "Text",
      label: "ERP Code",
      unique: true,
      caseSensitive: true,
      externalId: true,
    });
    await add({ type: "Email", label: "Login Email", unique: true, externalId: true });
    await add({ type: "Number", label: "Legacy Number", unique: true, externalId: true });
    expect(await field("ERP_Code__c")).toMatchObject({
      unique: true,
      caseSensitive: true,
      externalId: true,
    });
  });

  it("refuses an unknown type and a duplicate name", async () => {
    await expectError(
      add({ type: "Geolocation" as never, label: "Where" }),
      "INVALID_FIELD",
      "type",
    );
    await add({ type: "Text", label: "Region" });
    await expectError(
      add({ type: "Number", label: "Region", apiName: "REGION__c" }),
      "DUPLICATE_DEVELOPER_NAME",
    );
  });

  it("updates settings and keeps the rest", async () => {
    await add({ type: "Text", label: "Vendor Code", length: 20 });
    await org.run((ctx) =>
      updateField(ctx, "Invoice__c", "Vendor_Code__c", {
        length: 50,
        label: "Supplier Code",
        required: true,
      }),
    );
    expect(await field("Vendor_Code__c")).toMatchObject({
      length: 50,
      label: "Supplier Code",
      nillable: false,
    });
    await org.run((ctx) =>
      updateField(ctx, "Invoice__c", "Vendor_Code__c", { helpText: "From the ERP" }),
    );
    expect(await field("Vendor_Code__c")).toMatchObject({
      length: 50,
      inlineHelpText: "From the ERP",
    });
  });

  it("renames a field's API name", async () => {
    await add({ type: "Text", label: "Ref Old" });
    await org.run((ctx) => updateField(ctx, "Invoice__c", "Ref_Old__c", { apiName: "Ref_New" }));
    expect(await field("Ref_New__c")).toBeDefined();
    expect(await field("Ref_Old__c")).toBeUndefined();
  });

  it("refuses type changes, except the Name field between Text and Auto Number", async () => {
    await add({ type: "Text", label: "Code" });
    await expectError(
      org.run((ctx) => updateField(ctx, "Invoice__c", "Code__c", { type: "Number" })),
      "INVALID_TYPE_CHANGE",
      "type",
    );
  });

  it("protects the Name field and standard fields", async () => {
    await expectError(
      org.run((ctx) => deleteField(ctx, "Invoice__c", "Name")),
      "CANNOT_DELETE",
    );
    await expectError(
      org.run((ctx) => updateField(ctx, "Invoice__c", "Name", { required: false })),
      "NOT_SUPPORTED",
    );
    await expectError(
      org.run((ctx) => updateField(ctx, "Invoice__c", "Name", { apiName: "Title" })),
      "NOT_SUPPORTED",
    );
  });

  it("deletes a custom field", async () => {
    await add({ type: "Date", label: "Temp Date" });
    await org.run((ctx) => deleteField(ctx, "Invoice__c", "Temp_Date__c"));
    expect(await field("Temp_Date__c")).toBeUndefined();
  });

  it(`stops at ${LIMITS.externalIdsPerObject} external IDs and ${LIMITS.customFieldsPerObject} custom fields`, async () => {
    const big = await newOrg(env);
    await big.run((ctx) => createObject(ctx, invoice));
    await big.run(async (ctx) => {
      for (let i = 0; i < LIMITS.externalIdsPerObject; i++) {
        await createField(ctx, "Invoice__c", { type: "Text", label: `Ext ${i}`, externalId: true });
      }
    });
    await expectError(
      big.run((ctx) =>
        createField(ctx, "Invoice__c", { type: "Text", label: "One More", externalId: true }),
      ),
      "LIMIT_EXCEEDED",
    );
    await big.run(async (ctx) => {
      for (let i = LIMITS.externalIdsPerObject; i < LIMITS.customFieldsPerObject; i++) {
        await createField(ctx, "Invoice__c", { type: "Checkbox", label: `Flag ${i}` });
      }
    });
    await expectError(
      big.run((ctx) => createField(ctx, "Invoice__c", { type: "Date", label: "Too Many" })),
      "LIMIT_EXCEEDED",
    );
  });
});
