import { createField, createObject } from "@crm/metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecord, deleteRecord, getRecord, updateRecord } from "../src/index.js";
import { type Env, expectRecordError, hasDb, newOrg, setup, teardown } from "./helpers.js";

describe.skipIf(!hasDb)("record isolation and concurrency", () => {
  let env: Env;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(() => teardown(env));

  it("an org can't read, change, delete or point at another org's records", async () => {
    const a = await newOrg(env);
    const b = await newOrg(env);
    // Same object name in both orgs, so both get key prefix a00.
    for (const org of [a, b]) {
      await org.meta(async (ctx) => {
        await createObject(ctx, { label: "Account", pluralLabel: "Accounts", apiName: "Acct" });
        await createField(ctx, "Acct__c", {
          type: "Lookup",
          label: "Parent",
          referenceTo: "Acct__c",
          relationshipName: "Children",
        });
      });
    }
    const secret = (await a.run((c) => createRecord(c, "Acct__c", { Name: "A secret" }))).id;

    expect(
      await b.run((c) => getRecord(c, "Acct__c", secret, { includeDeleted: true })),
    ).toBeNull();
    await expectRecordError(
      b.run((c) => updateRecord(c, "Acct__c", secret, { Name: "pwned" })),
      "NOT_FOUND",
    );
    await expectRecordError(
      b.run((c) => deleteRecord(c, "Acct__c", secret)),
      "NOT_FOUND",
    );
    await expectRecordError(
      b.run((c) => createRecord(c, "Acct__c", { Name: "spy", Parent__c: secret })),
      "INVALID_CROSS_REFERENCE_KEY",
    );
    expect((await a.run((c) => getRecord(c, "Acct__c", secret)))?.Name).toBe("A secret");
  });

  it("an org can't make another org's user an owner or a lookup value", async () => {
    const a = await newOrg(env);
    const b = await newOrg(env);
    await b.meta(async (ctx) => {
      await createObject(ctx, { label: "Task", pluralLabel: "Tasks", apiName: "Job" });
      await createField(ctx, "Job__c", { type: "Lookup", label: "Assignee", referenceTo: "User" });
    });
    await expectRecordError(
      b.run((c) => createRecord(c, "Job__c", { Name: "j", OwnerId: a.userId })),
      "INVALID_CROSS_REFERENCE_KEY",
    );
    await expectRecordError(
      b.run((c) => createRecord(c, "Job__c", { Name: "j", Assignee__c: a.userId })),
      "INVALID_CROSS_REFERENCE_KEY",
    );
  });

  it("gives concurrent creates distinct, gap-free auto numbers", async () => {
    const org = await newOrg(env);
    await org.meta((ctx) =>
      createObject(ctx, {
        label: "Ticket",
        pluralLabel: "Tickets",
        nameField: { type: "AutoNumber", displayFormat: "T-{0000}" },
      }),
    );
    // Separate transactions on separate pooled connections, all at once.
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => org.run((c) => createRecord(c, "Ticket__c", {}))),
    );
    const names = await Promise.all(
      ids.map(({ id }) =>
        org.run(async (c) => (await getRecord(c, "Ticket__c", id))?.Name as string),
      ),
    );
    expect(new Set(names).size).toBe(20);
    expect([...names].sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `T-${String(i + 1).padStart(4, "0")}`),
    );
  });

  it("lets only one of several concurrent records claim a unique value", async () => {
    const org = await newOrg(env);
    await org.meta(async (ctx) => {
      await createObject(ctx, { label: "Badge", pluralLabel: "Badges" });
      await createField(ctx, "Badge__c", {
        type: "Text",
        label: "Number",
        unique: true,
        length: 10,
      });
    });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        org.run((c) => createRecord(c, "Badge__c", { Name: "b", Number__c: "B-1" })),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect(String((r as PromiseRejectedResult).reason)).toMatch(/duplicate value/);
    }
  });
});
