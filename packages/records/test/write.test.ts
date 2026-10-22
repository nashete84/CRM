import { createField, createObject, createRecordType } from "@crm/metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecord, getRecord, updateRecord, upsertRecord } from "../src/index.js";
import {
  type Env,
  type TestOrg,
  expectRecordError,
  hasDb,
  newOrg,
  salesModel,
  setup,
  teardown,
} from "./helpers.js";

describe.skipIf(!hasDb)("creating and updating records", () => {
  let env: Env;
  let org: TestOrg;
  let client: string;

  beforeAll(async () => {
    env = await setup();
    org = await newOrg(env);
    await salesModel(org);
    client = (await org.run((c) => createRecord(c, "Client__c", { Name: "Acme", Code__c: "ACME" })))
      .id;
  });
  afterAll(() => teardown(env));

  it("creates a record and returns it in Salesforce REST shape", async () => {
    const { id } = await org.run((c) =>
      createRecord(c, "Invoice__c", {
        Client__c: client,
        Total__c: "1234.5",
        Due_Date__c: "2026-11-30",
      }),
    );
    expect(id).toMatch(/^a01[0-9A-Za-z]{12}[A-Z0-5]{3}$/);
    const rec = await org.run((c) => getRecord(c, "Invoice__c", id));
    expect(rec).toMatchObject({
      attributes: { type: "Invoice__c", url: `/services/data/v62.0/sobjects/Invoice__c/${id}` },
      Id: id,
      IsDeleted: false,
      Client__c: client,
      Total__c: 1234.5,
      Due_Date__c: "2026-11-30",
      Paid__c: false, // checkbox default
      Status__c: "Sent", // picklist default
      CreatedById: org.userId,
    });
    expect(rec?.CreatedDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+0000$/);
    expect(rec).not.toHaveProperty("OwnerId"); // master-detail: sharing follows the parent
  });

  it("numbers records from the starting number, in order", async () => {
    const names: unknown[] = [];
    await org.run(async (c) => {
      for (let i = 0; i < 3; i++) {
        const { id } = await createRecord(c, "Invoice__c", { Client__c: client });
        names.push((await getRecord(c, "Invoice__c", id))?.Name);
      }
    });
    const numbers = names.map((n) => Number(String(n).slice(4)));
    expect(names[0]).toMatch(/^INV-\d{4}$/);
    expect(numbers[1]).toBe((numbers[0] as number) + 1);
    expect(numbers[2]).toBe((numbers[0] as number) + 2);
    expect(numbers[0]).toBeGreaterThanOrEqual(100);
  });

  it("gives the creator ownership, and checks a chosen owner", async () => {
    const { id } = await org.run((c) => createRecord(c, "Client__c", { Name: "Owned" }));
    expect((await org.run((c) => getRecord(c, "Client__c", id)))?.OwnerId).toBe(org.userId);
    const other = await org.addUser();
    await org.run((c) => updateRecord(c, "Client__c", id, { OwnerId: other }));
    expect((await org.run((c) => getRecord(c, "Client__c", id)))?.OwnerId).toBe(other);
    const inactive = await org.addUser({ active: false });
    await expectRecordError(
      org.run((c) => updateRecord(c, "Client__c", id, { OwnerId: inactive })),
      "INACTIVE_OWNER_OR_USER",
    );
    await expectRecordError(
      org.run((c) => updateRecord(c, "Client__c", id, { OwnerId: "005000000000000AAA" })),
      "INVALID_CROSS_REFERENCE_KEY",
    );
    await expectRecordError(
      org.run((c) => createRecord(c, "Invoice__c", { Client__c: client, OwnerId: other })),
      "INVALID_FIELD",
    );
  });

  it("reports every problem in one error, Salesforce style", async () => {
    const err = await expectRecordError(
      org.run((c) =>
        createRecord(c, "Invoice__c", { Total__c: "lots", Nope__c: 1, CreatedDate: "2020-01-01" }),
      ),
      "INVALID_FIELD",
    );
    expect(err.errors.map((e) => e.statusCode).sort()).toEqual(
      [
        "INVALID_FIELD",
        "INVALID_FIELD_FOR_INSERT_UPDATE",
        "INVALID_TYPE_ON_FIELD_IN_RECORD",
        "REQUIRED_FIELD_MISSING", // the master, Client__c
      ].sort(),
    );
  });

  it("requires required fields, including Name and the master", async () => {
    await expectRecordError(
      org.run((c) => createRecord(c, "Client__c", {})),
      "REQUIRED_FIELD_MISSING",
      ["Name"],
    );
    await expectRecordError(
      org.run((c) => createRecord(c, "Invoice__c", {})),
      "REQUIRED_FIELD_MISSING",
      ["Client__c"],
    );
    const { id } = await org.run((c) => createRecord(c, "Client__c", { Name: "Keep" }));
    await expectRecordError(
      org.run((c) => updateRecord(c, "Client__c", id, { Name: null })),
      "REQUIRED_FIELD_MISSING",
      ["Name"],
    );
  });

  it("refuses to set auto numbers and system fields, or move a detail to another master", async () => {
    await expectRecordError(
      org.run((c) => createRecord(c, "Invoice__c", { Client__c: client, Name: "X" })),
      "INVALID_FIELD_FOR_INSERT_UPDATE",
    );
    const other = (await org.run((c) => createRecord(c, "Client__c", { Name: "Other" }))).id;
    const { id } = await org.run((c) => createRecord(c, "Invoice__c", { Client__c: client }));
    await expectRecordError(
      org.run((c) => updateRecord(c, "Invoice__c", id, { Client__c: other })),
      "INVALID_FIELD_FOR_INSERT_UPDATE",
    );
    await org.run((c) => updateRecord(c, "Invoice__c", id, { Client__c: client, Total__c: 5 })); // unchanged master is fine
  });

  it("checks lookups point at existing records of the right object", async () => {
    await expectRecordError(
      org.run((c) => createRecord(c, "Invoice__c", { Client__c: "a00000000000000AAA" })),
      "INVALID_CROSS_REFERENCE_KEY",
    );
    const inv = (await org.run((c) => createRecord(c, "Invoice__c", { Client__c: client }))).id;
    await expectRecordError(
      org.run((c) => createRecord(c, "Invoice__c", { Client__c: inv })),
      "MALFORMED_ID",
    );
    await org.run((c) =>
      createRecord(c, "Note__c", { Name: "n", Pinned_Invoice__c: inv, Reviewer__c: org.userId }),
    );
    await expectRecordError(
      org.run((c) =>
        createRecord(c, "Note__c", {
          Name: "n",
          Pinned_Invoice__c: inv,
          Reviewer__c: "005000000000000AAA",
        }),
      ),
      "INVALID_CROSS_REFERENCE_KEY",
    );
  });

  it("enforces unique values case-insensitively and allows reuse after a change", async () => {
    await expectRecordError(
      org.run((c) => createRecord(c, "Client__c", { Name: "Dup", Code__c: "acme" })),
      "DUPLICATE_VALUE",
      ["Code__c"],
    );
    const { id } = await org.run((c) =>
      createRecord(c, "Client__c", { Name: "Beta", Code__c: "BETA" }),
    );
    await org.run((c) => updateRecord(c, "Client__c", id, { Code__c: "BETA" })); // its own value is fine
    await org.run((c) => updateRecord(c, "Client__c", id, { Code__c: "GAMMA" }));
    await org.run((c) => createRecord(c, "Client__c", { Name: "Beta 2", Code__c: "beta" }));
  });

  it("updates only the fields given and clears with null", async () => {
    const { id } = await org.run((c) =>
      createRecord(c, "Invoice__c", { Client__c: client, Total__c: 10, Due_Date__c: "2026-12-01" }),
    );
    await org.run((c) =>
      updateRecord(c, "Invoice__c", id, { Total__c: 12.345, Due_Date__c: null }),
    );
    expect(await org.run((c) => getRecord(c, "Invoice__c", id))).toMatchObject({
      Total__c: 12.35,
      Due_Date__c: null,
      Status__c: "Sent",
    });
  });

  it("upserts by external ID: creates once, then updates", async () => {
    const first = await org.run((c) =>
      upsertRecord(c, "Client__c", "Code__c", "ext-1", { Name: "Imported" }),
    );
    const second = await org.run((c) =>
      upsertRecord(c, "Client__c", "code__c", "EXT-1", { Name: "Imported (renamed)" }),
    );
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect((await org.run((c) => getRecord(c, "Client__c", first.id)))?.Name).toBe(
      "Imported (renamed)",
    );
    await expectRecordError(
      org.run((c) => upsertRecord(c, "Client__c", "Name", "x", {})),
      "INVALID_FIELD",
    );
  });

  it("refuses records of unknown and built-in objects", async () => {
    await expectRecordError(
      org.run((c) => createRecord(c, "Nope__c", {})),
      "INVALID_TYPE",
    );
    await expectRecordError(
      org.run((c) => createRecord(c, "User", { Name: "x" })),
      "INVALID_TYPE",
    );
  });

  describe("record types", () => {
    it("defaults to the first active record type and its picklist default", async () => {
      const o = await newOrg(env);
      await o.meta(async (ctx) => {
        await createObject(ctx, { label: "Case File", pluralLabel: "Case Files" });
        await createField(ctx, "Case_File__c", {
          type: "Picklist",
          label: "Priority",
          values: ["Low", { value: "Medium", isDefault: true }, "High"],
        });
        await createRecordType(ctx, "Case_File__c", {
          label: "Urgent",
          picklists: { Priority__c: { values: ["High"], default: "High" } },
        });
        await createRecordType(ctx, "Case_File__c", { label: "Routine" });
      });
      const { id } = await o.run((c) => createRecord(c, "Case_File__c", { Name: "x" }));
      const rec = await o.run((c) => getRecord(c, "Case_File__c", id));
      expect(rec?.Priority__c).toBe("High");
      expect(rec?.RecordTypeId).toMatch(/^012/);
      await expectRecordError(
        o.run((c) =>
          createRecord(c, "Case_File__c", { Name: "x", RecordTypeId: "012000000000001AAA" }),
        ),
        "INVALID_CROSS_REFERENCE_KEY",
      );
    });
  });
});
