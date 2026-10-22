import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecycleBin,
  purgeDeleted,
  undeleteRecord,
  updateRecord,
} from "../src/index.js";
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

describe.skipIf(!hasDb)("deleting records", () => {
  let env: Env;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(() => teardown(env));

  /** A client with two invoices, each with a line, and a note pointing at the client. */
  async function tree(org: TestOrg) {
    return org.run(async (c) => {
      const client = (
        await createRecord(c, "Client__c", {
          Name: "Acme",
          Code__c: `C-${Math.random().toString(36).slice(2, 10)}`,
        })
      ).id;
      const inv1 = (await createRecord(c, "Invoice__c", { Client__c: client })).id;
      const inv2 = (await createRecord(c, "Invoice__c", { Client__c: client })).id;
      const line1 = (await createRecord(c, "Line__c", { Name: "L1", Invoice__c: inv1 })).id;
      const line2 = (await createRecord(c, "Line__c", { Name: "L2", Invoice__c: inv2 })).id;
      const other = (await createRecord(c, "Client__c", { Name: "Other" })).id;
      const otherInv = (await createRecord(c, "Invoice__c", { Client__c: other })).id;
      const note = (
        await createRecord(c, "Note__c", {
          Name: "N",
          Client__c: client,
          Pinned_Invoice__c: otherInv,
        })
      ).id;
      return { client, inv1, inv2, line1, line2, other, otherInv, note };
    });
  }

  it("takes master-detail children down every level into the recycle bin", async () => {
    const org = await newOrg(env);
    await salesModel(org);
    const t = await tree(org);
    const res = await org.run((c) => deleteRecord(c, "Client__c", t.client));
    expect(new Set(res.deleted)).toEqual(new Set([t.client, t.inv1, t.inv2, t.line1, t.line2]));
    expect(await org.run((c) => getRecord(c, "Line__c", t.line1))).toBeNull();
    expect(
      (await org.run((c) => getRecord(c, "Line__c", t.line1, { includeDeleted: true })))?.IsDeleted,
    ).toBe(true);
    // The other client's tree is untouched.
    expect(await org.run((c) => getRecord(c, "Invoice__c", t.otherInv))).not.toBeNull();
  });

  it("clears SetNull lookups and puts them back on undelete", async () => {
    const org = await newOrg(env);
    await salesModel(org);
    const t = await tree(org);
    const res = await org.run((c) => deleteRecord(c, "Client__c", t.client));
    expect(res.clearedLookups).toBe(1);
    expect((await org.run((c) => getRecord(c, "Note__c", t.note)))?.Client__c).toBeNull();

    const back = await org.run((c) => undeleteRecord(c, "Client__c", t.client));
    expect(new Set(back.restored)).toEqual(new Set(res.deleted));
    expect(back.restoredLookups).toBe(1);
    expect((await org.run((c) => getRecord(c, "Note__c", t.note)))?.Client__c).toBe(t.client);
    expect((await org.run((c) => getRecord(c, "Line__c", t.line2)))?.IsDeleted).toBe(false);
  });

  it("doesn't overwrite a lookup someone set again while the parent was deleted", async () => {
    const org = await newOrg(env);
    await salesModel(org);
    const t = await tree(org);
    await org.run((c) => deleteRecord(c, "Client__c", t.client));
    await org.run((c) => updateRecord(c, "Note__c", t.note, { Client__c: t.other }));
    const back = await org.run((c) => undeleteRecord(c, "Client__c", t.client));
    expect(back.restoredLookups).toBe(0);
    expect((await org.run((c) => getRecord(c, "Note__c", t.note)))?.Client__c).toBe(t.other);
  });

  it("is blocked by a Restrict lookup and says which record blocks it", async () => {
    const org = await newOrg(env);
    await salesModel(org);
    const t = await tree(org);
    const err = await expectRecordError(
      org.run((c) => deleteRecord(c, "Client__c", t.other)),
      "DELETE_FAILED",
    );
    expect(err.message).toContain(t.note);
    expect(err.message).toContain("Note__c.Pinned_Invoice__c");
    expect(await org.run((c) => getRecord(c, "Client__c", t.other))).not.toBeNull();
  });

  it("frees unique values while deleted, and refuses undelete if they were taken", async () => {
    const org = await newOrg(env);
    await salesModel(org);
    const { id } = await org.run((c) =>
      createRecord(c, "Client__c", { Name: "Uniq", Code__c: "U1" }),
    );
    await org.run((c) => deleteRecord(c, "Client__c", id));
    const taker = await org.run((c) =>
      createRecord(c, "Client__c", { Name: "Taker", Code__c: "u1" }),
    );
    expect(taker.id).toBeTruthy();
    await expectRecordError(
      org.run((c) => undeleteRecord(c, "Client__c", id)),
      "DUPLICATE_VALUE",
    );
  });

  it("won't restore a detail while its master is deleted, or edit a deleted record", async () => {
    const org = await newOrg(env);
    await salesModel(org);
    const t = await tree(org);
    await org.run((c) => deleteRecord(c, "Client__c", t.client));
    await expectRecordError(
      org.run((c) => undeleteRecord(c, "Invoice__c", t.inv1)),
      "UNDELETE_FAILED",
    );
    await expectRecordError(
      org.run((c) => updateRecord(c, "Client__c", t.client, { Name: "x" })),
      "ENTITY_IS_DELETED",
    );
    await expectRecordError(
      org.run((c) => deleteRecord(c, "Client__c", t.client)),
      "ENTITY_IS_DELETED",
    );
    await expectRecordError(
      org.run((c) => createRecord(c, "Invoice__c", { Client__c: t.client })),
      "INVALID_CROSS_REFERENCE_KEY",
    );
  });

  it("restores a detail deleted on its own without touching its master", async () => {
    const org = await newOrg(env);
    await salesModel(org);
    const t = await tree(org);
    const res = await org.run((c) => deleteRecord(c, "Invoice__c", t.inv1));
    expect(new Set(res.deleted)).toEqual(new Set([t.inv1, t.line1]));
    await org.run((c) => undeleteRecord(c, "Invoice__c", t.inv1));
    expect(await org.run((c) => getRecord(c, "Line__c", t.line1))).not.toBeNull();
  });

  it("clears a restored record's lookup if its target was deleted meanwhile", async () => {
    const org = await newOrg(env);
    await salesModel(org);
    const t = await tree(org);
    const lone = (await org.run((c) => createRecord(c, "Client__c", { Name: "Lone" }))).id;
    const note = (
      await org.run((c) =>
        createRecord(c, "Note__c", { Name: "n2", Client__c: lone, Pinned_Invoice__c: t.otherInv }),
      )
    ).id;
    await org.run((c) => deleteRecord(c, "Note__c", note));
    await org.run((c) => deleteRecord(c, "Client__c", lone)); // nothing active points at it now
    const back = await org.run((c) => undeleteRecord(c, "Note__c", note));
    expect(back.clearedOnRestore).toBe(1);
    expect((await org.run((c) => getRecord(c, "Note__c", note)))?.Client__c).toBeNull();
  });

  it("lists the recycle bin and purges whole deletion groups", async () => {
    const org = await newOrg(env);
    await salesModel(org);
    const t = await tree(org);
    await org.run((c) => deleteRecord(c, "Client__c", t.client));
    const bin = await org.run((c) => listRecycleBin(c));
    expect(bin).toHaveLength(5);
    expect(bin.every((b) => b.group === 5)).toBe(true);
    expect(await org.run((c) => purgeDeleted(c, { olderThanDays: 15 }))).toEqual({ purged: 0 });
    expect(await org.run((c) => purgeDeleted(c, { ids: [t.line1] }))).toEqual({ purged: 5 });
    expect(
      await org.run((c) => getRecord(c, "Client__c", t.client, { includeDeleted: true })),
    ).toBeNull();
    await expectRecordError(
      org.run((c) => undeleteRecord(c, "Client__c", t.client)),
      "NOT_FOUND",
    );
    const left = await env.admin
      .selectFrom("record_index")
      .select("record_id")
      .where("record_id", "in", [t.client, t.inv1])
      .execute();
    expect(left).toEqual([]);
  });
});
