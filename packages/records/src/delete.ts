import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { type RecordCtx, loadMeta } from "./context.js";
import { RecordError } from "./errors.js";
import { getRow } from "./write.js";

/**
 * Deleting moves records to the recycle bin (DECISIONS.md D-032):
 *  - master-detail children go with their master, down every level;
 *  - a Restrict lookup from a surviving record blocks the delete;
 *  - a SetNull lookup from a surviving record is cleared, and logged so
 *    undelete can put it back.
 * Everything deleted together shares a deletion_id and is restored together.
 */

type RelField = {
  id: string;
  type: string;
  delete_constraint: string | null;
  api_name: string;
  object: string;
};

async function relationshipFields(ctx: RecordCtx): Promise<RelField[]> {
  return ctx.tx
    .selectFrom("field_def as f")
    .innerJoin("object_def as o", "o.id", "f.object_id")
    .select(["f.id", "f.type", "f.delete_constraint", "f.api_name", "o.api_name as object"])
    .where("f.reference_to", "is not", null)
    .execute();
}

/** Active records pointing at any of `ids` through these fields. */
async function pointingAt(ctx: RecordCtx, fieldIds: string[], ids: string[]) {
  if (fieldIds.length === 0 || ids.length === 0) return [];
  return ctx.tx
    .selectFrom("record_index")
    .select(["record_id", "field_id", "value_key"])
    .where("field_id", "in", fieldIds)
    .where("value_key", "in", ids)
    .where("is_active", "=", true)
    .execute();
}

export type DeleteResult = { id: string; deleted: string[]; clearedLookups: number };

export async function deleteRecord(
  ctx: RecordCtx,
  objectApiName: string,
  id: string,
): Promise<DeleteResult> {
  const meta = await loadMeta(ctx, objectApiName);
  const root = await getRow(ctx, meta, id);
  if (root.is_deleted)
    throw RecordError.of(
      "ENTITY_IS_DELETED",
      `entity is deleted: ${root.id} is already in the recycle bin.`,
    );

  const fields = await relationshipFields(ctx);
  const masterDetail = fields.filter((f) => f.type === "MasterDetail").map((f) => f.id);

  // 1. Everything that goes with the root: master-detail descendants, every level.
  const group = new Set([root.id]);
  let frontier = [root.id];
  while (frontier.length) {
    const children = await pointingAt(ctx, masterDetail, frontier);
    frontier = children.map((c) => c.record_id).filter((cid) => !group.has(cid));
    for (const cid of frontier) group.add(cid);
  }
  const ids = [...group];

  // 2. Survivors that point into the group through a lookup.
  const lookups = fields.filter((f) => f.type === "Lookup");
  const inbound = (
    await pointingAt(
      ctx,
      lookups.map((f) => f.id),
      ids,
    )
  ).filter((r) => !group.has(r.record_id));
  const restrictIds = new Set(
    lookups.filter((f) => f.delete_constraint === "Restrict").map((f) => f.id),
  );
  const blocking = inbound.filter((r) => restrictIds.has(r.field_id));
  if (blocking.length) {
    const byField = new Map(lookups.map((f) => [f.id, `${f.object}.${f.api_name}`]));
    const sample = blocking.slice(0, 5).map((b) => `${b.record_id} (${byField.get(b.field_id)})`);
    throw RecordError.of(
      "DELETE_FAILED",
      `Your attempt to delete ${root.id} could not be completed because ${blocking.length} other record(s) point to it through a lookup that prevents deletion: ${sample.join(", ")}${blocking.length > 5 ? ", ..." : ""}.`,
    );
  }

  const deletionId = randomUUID();
  // 3. Clear SetNull lookups and remember them for undelete.
  const toClear = inbound.filter((r) => !restrictIds.has(r.field_id));
  for (const r of toClear) {
    await ctx.tx
      .insertInto("recycle_cleared_lookup")
      .values({
        deletion_id: deletionId,
        org_id: ctx.orgId,
        record_id: r.record_id,
        field_id: r.field_id,
        value: r.value_key,
      })
      .execute();
    await ctx.tx
      .updateTable("record")
      .set({ data: sql`data - ${r.field_id}::text`, system_modstamp: sql`now()` })
      .where("id", "=", r.record_id)
      .execute();
    await ctx.tx
      .deleteFrom("record_index")
      .where("field_id", "=", r.field_id)
      .where("record_id", "=", r.record_id)
      .execute();
  }

  // 4. Into the recycle bin.
  await ctx.tx
    .updateTable("record")
    .set({
      is_deleted: true,
      deletion_id: deletionId,
      deleted_at: sql`now()`,
      deleted_by_id: ctx.userId,
      system_modstamp: sql`now()`,
    })
    .where("id", "in", ids)
    .execute();
  await ctx.tx
    .updateTable("record_index")
    .set({ is_active: false })
    .where("record_id", "in", ids)
    .execute();

  return { id: root.id, deleted: ids, clearedLookups: toClear.length };
}

export type UndeleteResult = {
  id: string;
  restored: string[];
  restoredLookups: number;
  clearedOnRestore: number;
};

export async function undeleteRecord(
  ctx: RecordCtx,
  objectApiName: string,
  id: string,
): Promise<UndeleteResult> {
  const meta = await loadMeta(ctx, objectApiName);
  const row = await getRow(ctx, meta, id);
  if (!row.is_deleted || !row.deletion_id) {
    throw RecordError.of("UNDELETE_FAILED", `${row.id} isn't in the recycle bin.`);
  }
  const deletionId = row.deletion_id;
  const group = (
    await ctx.tx.selectFrom("record").select("id").where("deletion_id", "=", deletionId).execute()
  ).map((r) => r.id);

  // Only the record that was deleted can be undeleted; its master-detail
  // children come back with it. A child whose master is deleted (in this
  // group or another) has to wait for the master.
  const fields = await relationshipFields(ctx);
  const masterDetail = fields.filter((f) => f.type === "MasterDetail").map((f) => f.id);
  const deletedMaster = masterDetail.length
    ? await ctx.tx
        .selectFrom("record_index as i")
        .innerJoin("record as m", "m.id", "i.value_key")
        .select("m.id as master")
        .where("i.record_id", "=", row.id)
        .where("i.field_id", "in", masterDetail)
        .where("m.is_deleted", "=", true)
        .executeTakeFirst()
    : undefined;
  if (deletedMaster) {
    throw RecordError.of(
      "UNDELETE_FAILED",
      `${row.id} was deleted with its master record. Undelete the master ${deletedMaster.master} instead.`,
    );
  }

  await ctx.tx
    .updateTable("record")
    .set({
      is_deleted: false,
      deletion_id: null,
      deleted_at: null,
      deleted_by_id: null,
      system_modstamp: sql`now()`,
    })
    .where("id", "in", group)
    .execute();
  try {
    await ctx.tx
      .updateTable("record_index")
      .set({ is_active: true })
      .where("record_id", "in", group)
      .execute();
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw RecordError.of(
        "DUPLICATE_VALUE",
        "Can't undelete: another record now uses one of this record's unique values.",
      );
    }
    throw err;
  }

  // Lookups in restored records that point at records deleted since are cleared, as a delete would have done.
  const lookupIds = fields.filter((f) => f.type === "Lookup").map((f) => f.id);
  const dangling = lookupIds.length
    ? await ctx.tx
        .selectFrom("record_index as i")
        .innerJoin("record as t", "t.id", "i.value_key")
        .select(["i.record_id", "i.field_id"])
        .where("i.record_id", "in", group)
        .where("i.field_id", "in", lookupIds)
        .where("t.is_deleted", "=", true)
        .execute()
    : [];
  for (const d of dangling) {
    await ctx.tx
      .updateTable("record")
      .set({ data: sql`data - ${d.field_id}::text` })
      .where("id", "=", d.record_id)
      .execute();
    await ctx.tx
      .deleteFrom("record_index")
      .where("field_id", "=", d.field_id)
      .where("record_id", "=", d.record_id)
      .execute();
  }

  // Put back lookups the delete cleared, unless the record has been given another value since.
  const cleared = await ctx.tx
    .selectFrom("recycle_cleared_lookup")
    .selectAll()
    .where("deletion_id", "=", deletionId)
    .execute();
  let restoredLookups = 0;
  for (const c of cleared) {
    const updated = await ctx.tx
      .updateTable("record")
      .set({
        data: sql`jsonb_set(data, ARRAY[${c.field_id}::text], to_jsonb(${c.value}::text))`,
        system_modstamp: sql`now()`,
      })
      .where("id", "=", c.record_id)
      .where("is_deleted", "=", false)
      .where(sql<boolean>`NOT (data ? ${c.field_id}::text)`)
      .executeTakeFirst();
    if (updated.numUpdatedRows > 0n) {
      restoredLookups += 1;
      await ctx.tx
        .insertInto("record_index")
        .values({
          org_id: ctx.orgId,
          field_id: c.field_id,
          record_id: c.record_id,
          value_key: c.value,
          is_unique: false,
        })
        .execute();
    }
  }
  await ctx.tx.deleteFrom("recycle_cleared_lookup").where("deletion_id", "=", deletionId).execute();

  return { id: row.id, restored: group, restoredLookups, clearedOnRestore: dangling.length };
}

/**
 * Permanently removes records from the recycle bin: the deletion groups of
 * the given records, or every group deleted more than `olderThanDays` ago
 * (Salesforce keeps deleted records for 15 days).
 */
export async function purgeDeleted(
  ctx: RecordCtx,
  options: { ids: string[] } | { olderThanDays: number },
): Promise<{ purged: number }> {
  let q = ctx.tx
    .selectFrom("record")
    .select("deletion_id")
    .distinct()
    .where("is_deleted", "=", true);
  if ("ids" in options) {
    if (options.ids.length === 0) return { purged: 0 };
    q = q.where("id", "in", options.ids);
  } else {
    q = q.where(
      "deleted_at",
      "<",
      sql<Date>`now() - make_interval(days => ${options.olderThanDays})`,
    );
  }
  const groups = (await q.execute())
    .map((r) => r.deletion_id)
    .filter((x): x is string => x !== null);
  if (groups.length === 0) return { purged: 0 };
  await ctx.tx.deleteFrom("recycle_cleared_lookup").where("deletion_id", "in", groups).execute();
  const res = await ctx.tx
    .deleteFrom("record")
    .where("deletion_id", "in", groups)
    .executeTakeFirst();
  return { purged: Number(res.numDeletedRows) };
}

export type RecycleBinEntry = {
  id: string;
  object: string;
  name: string | null;
  deletedAt: Date;
  deletedById: string | null;
  group: number;
};

/** What's in the recycle bin, newest first. `group` counts the records deleted together. */
export async function listRecycleBin(ctx: RecordCtx): Promise<RecycleBinEntry[]> {
  const rows = await ctx.tx
    .selectFrom("record as r")
    .innerJoin("object_def as o", "o.id", "r.object_id")
    .select(["r.id", "o.api_name", "r.name", "r.deleted_at", "r.deleted_by_id", "r.deletion_id"])
    .select(sql<number>`count(*) over (partition by r.deletion_id)::int`.as("group"))
    .where("r.is_deleted", "=", true)
    .orderBy("r.deleted_at", "desc")
    .orderBy("r.seq")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    object: r.api_name,
    name: r.name,
    deletedAt: r.deleted_at as Date,
    deletedById: r.deleted_by_id,
    group: r.group,
  }));
}
