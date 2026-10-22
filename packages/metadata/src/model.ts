import type {
  FieldDefTable,
  ObjectDefTable,
  PicklistValueTable,
  RecordTypeTable,
  Tx,
} from "@crm/db";
import { type Selectable, sql } from "kysely";
import { MetadataError } from "./errors.js";
import type { FieldType } from "./field-types.js";

export type ObjectRow = Selectable<ObjectDefTable>;
export type FieldRow = Omit<Selectable<FieldDefTable>, "type"> & { type: FieldType };
export type PicklistRow = Selectable<PicklistValueTable>;
export type RecordTypeRow = Selectable<RecordTypeTable>;

/** A transaction already scoped to one org with withOrg(). */
export type Ctx = { tx: Tx; orgId: string };

/** Everything known about one object, loaded in a fixed number of queries. */
export type ObjectMeta = {
  object: ObjectRow;
  fields: FieldRow[];
  picklistValues: Map<string, PicklistRow[]>; // by field id, in sort order
  recordTypes: RecordTypeRow[];
  /** record type id -> field id -> values offered (and which is the default) */
  recordTypeValues: Map<string, Map<string, { value: string; isDefault: boolean }[]>>;
  /** Relationship fields on other objects (or this one) that point here. */
  children: { field: FieldRow; childObject: string }[];
  /** API names of the objects this object's relationship fields point to, by object id. */
  referenceNames: Map<string, string>;
};

export async function findObject(ctx: Ctx, apiName: string): Promise<ObjectRow | undefined> {
  return ctx.tx
    .selectFrom("object_def")
    .selectAll()
    .where(sql`lower(api_name)`, "=", apiName.toLowerCase())
    .executeTakeFirst();
}

export async function getObject(ctx: Ctx, apiName: string): Promise<ObjectRow> {
  const obj = await findObject(ctx, apiName);
  if (!obj) throw new MetadataError("NOT_FOUND", `There's no object named ${apiName}.`);
  return obj;
}

export async function findField(
  ctx: Ctx,
  objectId: string,
  apiName: string,
): Promise<FieldRow | undefined> {
  return (await ctx.tx
    .selectFrom("field_def")
    .selectAll()
    .where("object_id", "=", objectId)
    .where(sql`lower(api_name)`, "=", apiName.toLowerCase())
    .executeTakeFirst()) as FieldRow | undefined;
}

export async function getField(ctx: Ctx, object: ObjectRow, apiName: string): Promise<FieldRow> {
  const field = await findField(ctx, object.id, apiName);
  if (!field) {
    throw new MetadataError("NOT_FOUND", `${object.api_name} has no field named ${apiName}.`);
  }
  return field;
}

export async function loadObjectMeta(ctx: Ctx, apiName: string): Promise<ObjectMeta> {
  const object = await getObject(ctx, apiName);
  const fields = (await ctx.tx
    .selectFrom("field_def")
    .selectAll()
    .where("object_id", "=", object.id)
    .orderBy("seq")
    .execute()) as FieldRow[];

  const fieldIds = fields.map((f) => f.id);
  const picklistRows = fieldIds.length
    ? await ctx.tx
        .selectFrom("picklist_value")
        .selectAll()
        .where("field_id", "in", fieldIds)
        .orderBy("sort_order")
        .execute()
    : [];
  const picklistValues = new Map<string, PicklistRow[]>();
  for (const row of picklistRows) {
    const list = picklistValues.get(row.field_id) ?? [];
    list.push(row);
    picklistValues.set(row.field_id, list);
  }

  const recordTypes = await ctx.tx
    .selectFrom("record_type")
    .selectAll()
    .where("object_id", "=", object.id)
    .orderBy("seq")
    .execute();
  const rtRows = recordTypes.length
    ? await ctx.tx
        .selectFrom("record_type_picklist_value as r")
        .innerJoin("picklist_value as p", (j) =>
          j.onRef("p.field_id", "=", "r.field_id").onRef("p.value", "=", "r.value"),
        )
        .select(["r.record_type_id", "r.field_id", "r.value", "r.is_default"])
        .where(
          "r.record_type_id",
          "in",
          recordTypes.map((r) => r.id),
        )
        .orderBy("p.sort_order")
        .execute()
    : [];
  const recordTypeValues = new Map<string, Map<string, { value: string; isDefault: boolean }[]>>();
  for (const row of rtRows) {
    const byField = recordTypeValues.get(row.record_type_id) ?? new Map();
    const list = byField.get(row.field_id) ?? [];
    list.push({ value: row.value, isDefault: row.is_default });
    byField.set(row.field_id, list);
    recordTypeValues.set(row.record_type_id, byField);
  }

  const childRows = await ctx.tx
    .selectFrom("field_def as f")
    .innerJoin("object_def as o", "o.id", "f.object_id")
    .selectAll("f")
    .select("o.api_name as child_object")
    .where("f.reference_to", "=", object.id)
    .orderBy("o.api_name")
    .orderBy("f.api_name")
    .execute();
  const children = childRows.map(({ child_object, ...field }) => ({
    field: field as FieldRow,
    childObject: child_object,
  }));

  const targetIds = [...new Set(fields.map((f) => f.reference_to).filter((x): x is string => !!x))];
  const targets = targetIds.length
    ? await ctx.tx
        .selectFrom("object_def")
        .select(["id", "api_name"])
        .where("id", "in", targetIds)
        .execute()
    : [];
  const referenceNames = new Map(targets.map((t) => [t.id, t.api_name]));

  return {
    object,
    fields,
    picklistValues,
    recordTypes,
    recordTypeValues,
    children,
    referenceNames,
  };
}
