import type { Db } from "@crm/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createField,
  createObject,
  deleteField,
  describeObject,
  updateField,
  updateObject,
} from "../src/index.js";
import { type TestOrg, expectError, hasDb, newOrg, setup, teardown } from "./helpers.js";

describe.skipIf(!hasDb)("relationships", () => {
  let env: { db: Db; admin: Db; orgs: string[] };
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(() => teardown(env));

  async function orgWith(...labels: string[]): Promise<TestOrg> {
    const org = await newOrg(env);
    for (const label of labels) {
      await org.run((ctx) => createObject(ctx, { label, pluralLabel: `${label}s` }));
    }
    return org;
  }

  it("creates a lookup, named on both sides the Salesforce way", async () => {
    const org = await orgWith("Client", "Invoice");
    await org.run((ctx) =>
      createField(ctx, "Invoice__c", { type: "Lookup", label: "Client", referenceTo: "Client__c" }),
    );
    const child = (await org.run((ctx) => describeObject(ctx, "Invoice__c"))).fields.find(
      (f) => f.name === "Client__c",
    );
    expect(child).toMatchObject({
      type: "reference",
      referenceTo: ["Client__c"],
      relationshipName: "Client__r",
      cascadeDelete: false,
      restrictedDelete: false,
      nillable: true,
    });
    const parent = await org.run((ctx) => describeObject(ctx, "Client__c"));
    expect(parent.childRelationships).toEqual([
      {
        childSObject: "Invoice__c",
        field: "Client__c",
        relationshipName: "Invoices__r",
        cascadeDelete: false,
        restrictedDelete: false,
      },
    ]);
  });

  it("requires Restrict for a required lookup", async () => {
    const org = await orgWith("Client", "Invoice");
    await expectError(
      org.run((ctx) =>
        createField(ctx, "Invoice__c", {
          type: "Lookup",
          label: "Client",
          referenceTo: "Client__c",
          required: true,
          deleteConstraint: "SetNull",
        }),
      ),
      "INVALID_FIELD",
      "deleteConstraint",
    );
    await org.run((ctx) =>
      createField(ctx, "Invoice__c", {
        type: "Lookup",
        label: "Client",
        referenceTo: "Client__c",
        required: true,
      }),
    );
    const f = (await org.run((ctx) => describeObject(ctx, "Invoice__c"))).fields.find(
      (x) => x.name === "Client__c",
    );
    expect(f).toMatchObject({ nillable: false, restrictedDelete: true });
    await expectError(
      org.run((ctx) =>
        updateField(ctx, "Invoice__c", "Client__c", { deleteConstraint: "SetNull" }),
      ),
      "INVALID_FIELD",
      "deleteConstraint",
    );
  });

  it("looks up to User and to its own object", async () => {
    const org = await orgWith("Region");
    await org.run((ctx) =>
      createField(ctx, "Region__c", { type: "Lookup", label: "Manager", referenceTo: "User" }),
    );
    await org.run((ctx) =>
      createField(ctx, "Region__c", {
        type: "Lookup",
        label: "Parent",
        referenceTo: "Region__c",
        relationshipName: "Subregions",
      }),
    );
    const d = await org.run((ctx) => describeObject(ctx, "Region__c"));
    expect(d.fields.find((f) => f.name === "Manager__c")?.referenceTo).toEqual(["User"]);
    expect(d.childRelationships.map((c) => c.relationshipName)).toEqual(["Subregions__r"]);
    const user = await org.run((ctx) => describeObject(ctx, "User"));
    expect(user.childRelationships.map((c) => `${c.childSObject}.${c.field}`)).toEqual([
      "Region__c.Manager__c",
    ]);
  });

  it("refuses a missing parent and a duplicate child relationship name", async () => {
    const org = await orgWith("Client", "Invoice", "Quote");
    await expectError(
      org.run((ctx) =>
        createField(ctx, "Invoice__c", { type: "Lookup", label: "Thing", referenceTo: "Nope__c" }),
      ),
      "NOT_FOUND",
      "referenceTo",
    );
    await org.run((ctx) =>
      createField(ctx, "Invoice__c", {
        type: "Lookup",
        label: "Client",
        referenceTo: "Client__c",
        relationshipName: "Documents",
      }),
    );
    await expectError(
      org.run((ctx) =>
        createField(ctx, "Quote__c", {
          type: "Lookup",
          label: "Client",
          referenceTo: "Client__c",
          relationshipName: "documents",
        }),
      ),
      "DUPLICATE_DEVELOPER_NAME",
      "relationshipName",
    );
  });

  it("can't repoint a relationship", async () => {
    const org = await orgWith("Client", "Invoice", "Vendor");
    await org.run((ctx) =>
      createField(ctx, "Invoice__c", { type: "Lookup", label: "Party", referenceTo: "Client__c" }),
    );
    await expectError(
      org.run((ctx) => updateField(ctx, "Invoice__c", "Party__c", { referenceTo: "Vendor__c" })),
      "INVALID_TYPE_CHANGE",
      "referenceTo",
    );
  });

  describe("master-detail", () => {
    it("makes the detail's sharing follow the master and hides its owner", async () => {
      const org = await orgWith("Client", "Invoice");
      await org.run((ctx) =>
        createField(ctx, "Invoice__c", {
          type: "MasterDetail",
          label: "Client",
          referenceTo: "Client__c",
        }),
      );
      const d = await org.run((ctx) => describeObject(ctx, "Invoice__c"));
      expect(d.sharingModel).toBe("ControlledByParent");
      expect(d.fields.some((f) => f.name === "OwnerId")).toBe(false);
      expect(d.fields.find((f) => f.name === "Client__c")).toMatchObject({
        nillable: false,
        cascadeDelete: true,
        updateable: false,
        relationshipOrder: 0,
      });
      await expectError(
        org.run((ctx) => updateObject(ctx, "Invoice__c", { sharingModel: "Private" })),
        "FIELD_INTEGRITY_EXCEPTION",
      );
      await expectError(
        org.run((ctx) => updateField(ctx, "Invoice__c", "Client__c", { required: false })),
        "INVALID_FIELD",
      );
    });

    it("gives sharing back to the object when the last master-detail field goes", async () => {
      const org = await orgWith("Client", "Invoice");
      await org.run((ctx) =>
        createField(ctx, "Invoice__c", {
          type: "MasterDetail",
          label: "Client",
          referenceTo: "Client__c",
        }),
      );
      await org.run((ctx) => deleteField(ctx, "Invoice__c", "Client__c"));
      const d = await org.run((ctx) => describeObject(ctx, "Invoice__c"));
      expect(d.sharingModel).toBe("ReadWrite");
      expect(d.fields.some((f) => f.name === "OwnerId")).toBe(true);
    });

    it("refuses to point at itself, at User, or to take a delete rule", async () => {
      const org = await orgWith("Invoice");
      await expectError(
        org.run((ctx) =>
          createField(ctx, "Invoice__c", {
            type: "MasterDetail",
            label: "Self",
            referenceTo: "Invoice__c",
          }),
        ),
        "FIELD_INTEGRITY_EXCEPTION",
      );
      await expectError(
        org.run((ctx) =>
          createField(ctx, "Invoice__c", {
            type: "MasterDetail",
            label: "Owner2",
            referenceTo: "User",
          }),
        ),
        "FIELD_INTEGRITY_EXCEPTION",
      );
      await expectError(
        org.run((ctx) =>
          createField(ctx, "Invoice__c", {
            type: "MasterDetail",
            label: "X",
            referenceTo: "User",
            deleteConstraint: "SetNull",
          }),
        ),
        "INVALID_FIELD",
        "deleteConstraint",
      );
    });

    it("allows two masters (a junction object) but not three", async () => {
      const org = await orgWith("Course", "Student", "Term", "Enrollment");
      await org.run((ctx) =>
        createField(ctx, "Enrollment__c", {
          type: "MasterDetail",
          label: "Course",
          referenceTo: "Course__c",
        }),
      );
      await org.run((ctx) =>
        createField(ctx, "Enrollment__c", {
          type: "MasterDetail",
          label: "Student",
          referenceTo: "Student__c",
        }),
      );
      const d = await org.run((ctx) => describeObject(ctx, "Enrollment__c"));
      expect(
        d.fields.filter((f) => f.relationshipOrder !== null).map((f) => f.relationshipOrder),
      ).toEqual([0, 1]);
      await expectError(
        org.run((ctx) =>
          createField(ctx, "Enrollment__c", {
            type: "MasterDetail",
            label: "Term",
            referenceTo: "Term__c",
          }),
        ),
        "LIMIT_EXCEEDED",
      );
    });

    it("allows three levels and refuses a fourth, from either end", async () => {
      const org = await orgWith("Level1", "Level2", "Level3", "Level4", "Level0");
      await org.run((ctx) =>
        createField(ctx, "Level2__c", {
          type: "MasterDetail",
          label: "L1",
          referenceTo: "Level1__c",
        }),
      );
      await org.run((ctx) =>
        createField(ctx, "Level3__c", {
          type: "MasterDetail",
          label: "L2",
          referenceTo: "Level2__c",
        }),
      );
      // Below the bottom.
      await expectError(
        org.run((ctx) =>
          createField(ctx, "Level4__c", {
            type: "MasterDetail",
            label: "L3",
            referenceTo: "Level3__c",
          }),
        ),
        "LIMIT_EXCEEDED",
      );
      // Above the top.
      await expectError(
        org.run((ctx) =>
          createField(ctx, "Level1__c", {
            type: "MasterDetail",
            label: "L0",
            referenceTo: "Level0__c",
          }),
        ),
        "LIMIT_EXCEEDED",
      );
    });

    it("refuses a loop", async () => {
      const org = await orgWith("Alpha", "Beta");
      await org.run((ctx) =>
        createField(ctx, "Beta__c", {
          type: "MasterDetail",
          label: "Alpha",
          referenceTo: "Alpha__c",
        }),
      );
      await expectError(
        org.run((ctx) =>
          createField(ctx, "Alpha__c", {
            type: "MasterDetail",
            label: "Beta",
            referenceTo: "Beta__c",
          }),
        ),
        "FIELD_INTEGRITY_EXCEPTION",
      );
    });
  });

  describe("standard objects (platform seeding)", () => {
    it("names standard relationships without suffixes", async () => {
      const org = await newOrg(env);
      await org.run((ctx) =>
        createObject(
          ctx,
          { apiName: "Account", label: "Account", pluralLabel: "Accounts" },
          { standard: { keyPrefix: "001" } },
        ),
      );
      await org.run((ctx) =>
        createObject(
          ctx,
          { apiName: "Contact", label: "Contact", pluralLabel: "Contacts" },
          { standard: { keyPrefix: "003" } },
        ),
      );
      await org.run((ctx) =>
        createField(
          ctx,
          "Contact",
          {
            type: "Lookup",
            apiName: "AccountId",
            label: "Account ID",
            referenceTo: "Account",
            relationshipName: "Contacts",
          },
          { standard: true },
        ),
      );
      const contact = await org.run((ctx) => describeObject(ctx, "Contact"));
      expect(contact).toMatchObject({ keyPrefix: "003", custom: false });
      expect(contact.fields.find((f) => f.name === "AccountId")).toMatchObject({
        relationshipName: "Account",
        custom: false,
      });
      const account = await org.run((ctx) => describeObject(ctx, "Account"));
      expect(account.childRelationships[0]?.relationshipName).toBe("Contacts");
      await expectError(
        org.run((ctx) =>
          createField(
            ctx,
            "Contact",
            { type: "Text", apiName: "OwnerId", label: "Owner" },
            { standard: true },
          ),
        ),
        "INVALID_NAME",
      );
      await expectError(
        org.run((ctx) => deleteField(ctx, "Contact", "AccountId")),
        "CANNOT_DELETE",
      );
      await expectError(
        org.run((ctx) => updateField(ctx, "Contact", "AccountId", { required: true })),
        "NOT_SUPPORTED",
      );
    });
  });
});
