import { type RawBuilder, sql } from "kysely";
import { MetadataError } from "./errors.js";
import type { Ctx, FieldRow, ObjectRow } from "./model.js";
import { type StoredValue, formatAutoNumber, indexKey, isIndexed } from "./values.js";

/**
 * What metadata changes do to records that already exist (DECISIONS.md D-033).
 * Rule: a schema change never leaves stored data invalid and never loses data
 * silently. Changes that would are refused with a count of the records in the
 * way; changes that can be applied to the data (renames, re-numbering) are.
 */

/** The stored value of a field as SQL text: the Name column or data->>fieldId. */
function valueSql(field: FieldRow): RawBuilder<string | null> {
  return field.is_name_field
    ? sql<string | null>`name`
    : sql<string | null>`data->>${field.id}::text`;
}

async function count(
  ctx: Ctx,
  objectId: string,
  where: RawBuilder<unknown>,
  includeDeleted = false,
): Promise<number> {
  const deleted = includeDeleted ? sql`true` : sql`NOT is_deleted`;
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM record WHERE object_id = ${objectId} AND ${deleted} AND (${where})
  `.execute(ctx.tx);
  return rows[0]?.n ?? 0;
}

export async function recordCount(
  ctx: Ctx,
  objectId: string,
  includeDeleted = true,
): Promise<number> {
  return count(ctx, objectId, sql`true`, includeDeleted);
}

/** Throws "1 record has ..." / "3 records have ...": `what` is [singular, plural] wording. */
function refuse(n: number, what: [string, string], fix: string, path?: string): never {
  const subject = n === 1 ? `1 record ${what[0]}` : `${n} records ${what[1]}`;
  throw new MetadataError("FIELD_INTEGRITY_EXCEPTION", `${subject}. ${fix}`, path);
}

/** Making a field required: every record must already have a value. */
export async function checkCanRequire(ctx: Ctx, field: FieldRow): Promise<void> {
  const n = await count(ctx, field.object_id, sql`${valueSql(field)} IS NULL`);
  if (n > 0) {
    refuse(
      n,
      [`has no ${field.label}`, `have no ${field.label}`],
      "Fill them in before making the field required.",
      "required",
    );
  }
}

/** Shortening text: every stored value must still fit. */
export async function checkTextFits(ctx: Ctx, field: FieldRow, maxLength: number): Promise<void> {
  const n = await count(
    ctx,
    field.object_id,
    sql`char_length(${valueSql(field)}) > ${maxLength}`,
    true,
  );
  if (n > 0) {
    refuse(
      n,
      [
        `has a ${field.label} longer than ${maxLength} characters`,
        `have a ${field.label} longer than ${maxLength} characters`,
      ],
      "Shorten those values first.",
      "length",
    );
  }
}

/** Changing precision or scale: no value may lose digits. */
export async function checkNumbersFit(
  ctx: Ctx,
  field: FieldRow,
  precision: number,
  scale: number,
): Promise<void> {
  const v = sql`(${valueSql(field)})::numeric`;
  const n = await count(
    ctx,
    field.object_id,
    sql`${valueSql(field)} IS NOT NULL AND (abs(${v}) >= 10::numeric ^ ${precision - scale} OR scale(trim_scale(${v})) > ${scale})`,
    true,
  );
  if (n > 0) {
    refuse(
      n,
      [
        `has a ${field.label} that doesn't fit ${precision - scale} digits before and ${scale} after the decimal point`,
        `have a ${field.label} that doesn't fit ${precision - scale} digits before and ${scale} after the decimal point`,
      ],
      "Change those values first, or keep the current precision and scale.",
      "precision",
    );
  }
}

/** Rewrites stored numbers with the new number of decimal places ("12.5" -> "12.50"). */
export async function reformatNumbers(ctx: Ctx, field: FieldRow, scale: number): Promise<void> {
  await sql`
    UPDATE record
    SET data = jsonb_set(data, ARRAY[${field.id}::text], to_jsonb(round((data->>${field.id}::text)::numeric, ${scale})::text))
    WHERE object_id = ${field.object_id} AND data ? ${field.id}::text
  `.execute(ctx.tx);
}

/** Making a picklist restricted: every stored value must be one of its values. */
export async function checkValuesInPicklist(
  ctx: Ctx,
  field: FieldRow,
  values: string[],
): Promise<void> {
  const list = values.length ? values : [""];
  const outside =
    field.type === "MultiselectPicklist"
      ? sql`EXISTS (SELECT 1 FROM unnest(string_to_array(${valueSql(field)}, ';')) AS v(x) WHERE v.x <> ALL(${list}::text[]))`
      : sql`${valueSql(field)} <> ALL(${list}::text[])`;
  const n = await count(
    ctx,
    field.object_id,
    sql`${valueSql(field)} IS NOT NULL AND ${outside}`,
    true,
  );
  if (n > 0) {
    refuse(
      n,
      [
        `has a ${field.label} value that isn't in the picklist`,
        `have a ${field.label} value that isn't in the picklist`,
      ],
      "Change or add those values first.",
      "restricted",
    );
  }
}

/**
 * Brings record_index in line with the field's current settings: removes its
 * rows, then re-adds them if the field is indexed. Refuses if the field is now
 * unique and live records share a value.
 */
export async function rebuildIndex(ctx: Ctx, field: FieldRow): Promise<void> {
  await ctx.tx.deleteFrom("record_index").where("field_id", "=", field.id).execute();
  if (!isIndexed(field)) return;
  const { rows } = await sql<{ id: string; value: string | null; is_deleted: boolean }>`
    SELECT id, ${valueSql(field)} AS value, is_deleted FROM record
    WHERE object_id = ${field.object_id} AND ${valueSql(field)} IS NOT NULL
  `.execute(ctx.tx);
  const entries = rows.map((r) => ({
    record_id: r.id,
    value_key: indexKey(field, r.value as StoredValue),
    is_active: !r.is_deleted,
  }));
  if (field.is_unique) {
    const seen = new Map<string, number>();
    for (const e of entries)
      if (e.is_active) seen.set(e.value_key, (seen.get(e.value_key) ?? 0) + 1);
    const dupes = [...seen.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);
    if (dupes > 0) {
      refuse(
        dupes,
        [
          `shares a ${field.label} value with another record`,
          `share ${field.label} values with other records`,
        ],
        "Make the values unique first.",
        "unique",
      );
    }
  }
  for (let i = 0; i < entries.length; i += 500) {
    await ctx.tx
      .insertInto("record_index")
      .values(
        entries.slice(i, i + 500).map((e) => ({
          org_id: ctx.orgId,
          field_id: field.id,
          record_id: e.record_id,
          value_key: e.value_key,
          is_unique: field.is_unique,
          is_active: e.is_active,
        })),
      )
      .execute();
  }
}

/** Numbers existing records, oldest first, as Salesforce does for a new auto number field. */
export async function backfillAutoNumbers(ctx: Ctx, field: FieldRow): Promise<void> {
  const props = field.props as { displayFormat: string; startingNumber: number };
  const records = await ctx.tx
    .selectFrom("record")
    .select("id")
    .where("object_id", "=", field.object_id)
    .orderBy("seq")
    .execute();
  let n = BigInt(props.startingNumber);
  for (const r of records) {
    const value = formatAutoNumber(props.displayFormat, n);
    if (field.is_name_field) {
      await ctx.tx.updateTable("record").set({ name: value }).where("id", "=", r.id).execute();
    } else {
      await sql`UPDATE record SET data = jsonb_set(data, ARRAY[${field.id}::text], to_jsonb(${value}::text)) WHERE id = ${r.id}`.execute(
        ctx.tx,
      );
    }
    n += 1n;
  }
  await ctx.tx
    .insertInto("autonumber_counter")
    .values({ field_id: field.id, org_id: ctx.orgId, next_value: n.toString() })
    .onConflict((oc) => oc.column("field_id").doUpdateSet({ next_value: n.toString() }))
    .execute();
}

/** Sets a value on every existing record (a new checkbox with a true default). */
export async function fillValue(ctx: Ctx, field: FieldRow, value: StoredValue): Promise<void> {
  await sql`
    UPDATE record SET data = jsonb_set(data, ARRAY[${field.id}::text], ${JSON.stringify(value)}::jsonb)
    WHERE object_id = ${field.object_id}
  `.execute(ctx.tx);
}

/** Removes a deleted field's values from every record. */
export async function stripField(ctx: Ctx, field: FieldRow): Promise<void> {
  await sql`UPDATE record SET data = data - ${field.id}::text WHERE object_id = ${field.object_id} AND data ? ${field.id}::text`.execute(
    ctx.tx,
  );
}

/** Renames a picklist value inside every record, keeping multi-select order. */
export async function renamePicklistValueInRecords(
  ctx: Ctx,
  field: FieldRow,
  from: string,
  to: string,
): Promise<void> {
  const replaced =
    field.type === "MultiselectPicklist"
      ? sql`array_to_string(array_replace(string_to_array(data->>${field.id}::text, ';'), ${from}::text, ${to}::text), ';')`
      : sql`${to}::text`;
  const matches =
    field.type === "MultiselectPicklist"
      ? sql`${from}::text = ANY(string_to_array(data->>${field.id}::text, ';'))`
      : sql`data->>${field.id}::text = ${from}`;
  await sql`
    UPDATE record SET data = jsonb_set(data, ARRAY[${field.id}::text], to_jsonb(${replaced}))
    WHERE object_id = ${field.object_id} AND ${matches}
  `.execute(ctx.tx);
}

/**
 * Removes a picklist value from records: replaced by `replaceWith` when given,
 * otherwise cleared. A required field must be given a replacement.
 */
export async function removePicklistValueFromRecords(
  ctx: Ctx,
  field: FieldRow,
  value: string,
  replaceWith: string | undefined,
): Promise<number> {
  const uses =
    field.type === "MultiselectPicklist"
      ? sql`${value}::text = ANY(string_to_array(data->>${field.id}::text, ';'))`
      : sql`data->>${field.id}::text = ${value}`;
  const n = await count(ctx, field.object_id, uses, true);
  if (n === 0) return 0;
  if (replaceWith !== undefined) {
    if (field.type === "MultiselectPicklist") {
      // Replace, drop a duplicate if the record already had the replacement,
      // and keep the picklist's own order (as every save does).
      await sql`
        UPDATE record SET data = jsonb_set(data, ARRAY[${field.id}::text], to_jsonb(
          (SELECT string_agg(s.x, ';' ORDER BY p.sort_order NULLS LAST, s.x)
           FROM (SELECT DISTINCT CASE WHEN v = ${value} THEN ${replaceWith}::text ELSE v END AS x
                 FROM unnest(string_to_array(data->>${field.id}::text, ';')) AS t(v)) s
           LEFT JOIN picklist_value p ON p.field_id = ${field.id} AND p.value = s.x)))
        WHERE object_id = ${field.object_id} AND ${uses}
      `.execute(ctx.tx);
    } else {
      await renamePicklistValueInRecords(ctx, field, value, replaceWith);
    }
    return n;
  }
  if (field.type === "MultiselectPicklist") {
    const remaining = sql`array_to_string(array_remove(string_to_array(data->>${field.id}::text, ';'), ${value}::text), ';')`;
    if (field.required) {
      const emptied = await count(ctx, field.object_id, sql`${uses} AND ${remaining} = ''`, true);
      if (emptied > 0) {
        refuse(
          emptied,
          [`would have no ${field.label} left`, `would have no ${field.label} left`],
          "Give a replacement value.",
          "replaceWith",
        );
      }
    }
    await sql`
      UPDATE record SET data = CASE WHEN ${remaining} = '' THEN data - ${field.id}::text
                                    ELSE jsonb_set(data, ARRAY[${field.id}::text], to_jsonb(${remaining})) END
      WHERE object_id = ${field.object_id} AND ${uses}
    `.execute(ctx.tx);
    return n;
  }
  if (field.required) {
    refuse(
      n,
      [
        `uses "${value}" in ${field.label}, which is required`,
        `use "${value}" in ${field.label}, which is required`,
      ],
      "Give a replacement value.",
      "replaceWith",
    );
  }
  await sql`UPDATE record SET data = data - ${field.id}::text WHERE object_id = ${field.object_id} AND ${uses}`.execute(
    ctx.tx,
  );
  return n;
}

/** Some changes need an object with no records at all (adding a master-detail field). */
export async function checkNoRecords(
  ctx: Ctx,
  object: ObjectRow,
  why: string,
  path = "type",
): Promise<void> {
  const n = await recordCount(ctx, object.id);
  if (n > 0) refuse(n, [`of ${object.api_name} exists`, `of ${object.api_name} exist`], why, path);
}
