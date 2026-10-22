import { KeyPrefix, newId } from "@crm/db";
import { sql } from "kysely";
import { MetadataError, isUniqueViolation } from "./errors.js";
import { TYPE_SPECS } from "./field-types.js";
import { type Ctx, type ObjectRow, type RecordTypeRow, getObject } from "./model.js";
import { checkLabel, nameFromLabel } from "./names.js";

/** Which values a record type offers for one picklist field, and its default. */
export type RecordTypePicklist = { values: string[]; default?: string };

export type RecordTypeInput = {
  developerName?: string;
  label: string;
  description?: string;
  isActive?: boolean;
  /** By picklist field API name. Fields not listed offer all their active values. */
  picklists?: Record<string, RecordTypePicklist>;
};

export type RecordTypePatch = Partial<Omit<RecordTypeInput, "developerName">>;

const DEV_NAME_RE = /^[A-Za-z](?:(?:[A-Za-z0-9]|_(?!_))*[A-Za-z0-9])?$/;

function checkDeveloperName(name: string): string {
  const n = name.trim();
  if (n.length === 0 || n.length > 80 || !DEV_NAME_RE.test(n)) {
    throw new MetadataError(
      "INVALID_NAME",
      `Record type name "${n}" must be up to 80 letters, numbers and single underscores, starting with a letter and not ending in an underscore.`,
      "developerName",
    );
  }
  return n;
}

async function getRecordType(
  ctx: Ctx,
  object: ObjectRow,
  developerName: string,
): Promise<RecordTypeRow> {
  const rt = await ctx.tx
    .selectFrom("record_type")
    .selectAll()
    .where("object_id", "=", object.id)
    .where(sql`lower(developer_name)`, "=", developerName.toLowerCase())
    .executeTakeFirst();
  if (!rt)
    throw new MetadataError(
      "NOT_FOUND",
      `${object.api_name} has no record type named ${developerName}.`,
    );
  return rt;
}

/** Works out the value set for every picklist field of the object. */
async function resolvePicklists(
  ctx: Ctx,
  object: ObjectRow,
  input: Record<string, RecordTypePicklist> | undefined,
  onlyListed: boolean,
): Promise<Map<string, { values: string[]; default: string | null }>> {
  const fields = (
    await ctx.tx
      .selectFrom("field_def")
      .select(["id", "api_name", "type"])
      .where("object_id", "=", object.id)
      .execute()
  ).filter((f) => TYPE_SPECS[f.type as keyof typeof TYPE_SPECS]?.isPicklist);
  const byName = new Map(fields.map((f) => [f.api_name.toLowerCase(), f]));

  for (const name of Object.keys(input ?? {})) {
    if (!byName.has(name.toLowerCase())) {
      throw new MetadataError(
        "NOT_FOUND",
        `${object.api_name} has no picklist field named ${name}.`,
        `picklists.${name}`,
      );
    }
  }

  const result = new Map<string, { values: string[]; default: string | null }>();
  for (const f of fields) {
    const entry = Object.entries(input ?? {}).find(
      ([k]) => k.toLowerCase() === f.api_name.toLowerCase(),
    )?.[1];
    if (!entry && onlyListed) continue;
    const active = await ctx.tx
      .selectFrom("picklist_value")
      .select(["value", "is_default"])
      .where("field_id", "=", f.id)
      .where("is_active", "=", true)
      .orderBy("sort_order")
      .execute();
    if (!entry) {
      result.set(f.id, {
        values: active.map((v) => v.value),
        default: active.find((v) => v.is_default)?.value ?? null,
      });
      continue;
    }
    const path = `picklists.${f.api_name}`;
    if (!Array.isArray(entry.values) || entry.values.length === 0) {
      throw new MetadataError(
        "INVALID_FIELD",
        `Choose at least one value for ${f.api_name}.`,
        path,
      );
    }
    const canonical = (v: string) => {
      const hit = active.find((a) => a.value.toLowerCase() === String(v).trim().toLowerCase());
      if (!hit)
        throw new MetadataError(
          "INVALID_FIELD",
          `"${v}" isn't an active value of ${f.api_name}.`,
          path,
        );
      return hit.value;
    };
    const values = [...new Set(entry.values.map(canonical))];
    let def: string | null = null;
    if (entry.default !== undefined) {
      def = canonical(entry.default);
      if (!values.includes(def)) {
        throw new MetadataError(
          "INVALID_FIELD",
          `The default for ${f.api_name} must be one of the chosen values.`,
          path,
        );
      }
    }
    result.set(f.id, { values, default: def });
  }
  return result;
}

async function writePicklists(
  ctx: Ctx,
  recordTypeId: string,
  picklists: Map<string, { values: string[]; default: string | null }>,
): Promise<void> {
  for (const [fieldId, set] of picklists) {
    await ctx.tx
      .deleteFrom("record_type_picklist_value")
      .where("record_type_id", "=", recordTypeId)
      .where("field_id", "=", fieldId)
      .execute();
    if (set.values.length === 0) continue;
    await ctx.tx
      .insertInto("record_type_picklist_value")
      .values(
        set.values.map((value) => ({
          org_id: ctx.orgId,
          record_type_id: recordTypeId,
          field_id: fieldId,
          value,
          is_default: value === set.default,
        })),
      )
      .execute();
  }
}

export async function createRecordType(
  ctx: Ctx,
  objectApiName: string,
  input: RecordTypeInput,
): Promise<RecordTypeRow> {
  const object = await getObject(ctx, objectApiName);
  if (object.storage === "platform") {
    throw new MetadataError("NOT_SUPPORTED", `${object.api_name} doesn't support record types.`);
  }
  const label = checkLabel(input.label, "label", 80);
  const developerName = checkDeveloperName(input.developerName ?? nameFromLabel(label));
  if (developerName.toLowerCase() === "master") {
    throw new MetadataError(
      "INVALID_NAME",
      "Master is reserved for the built-in record type.",
      "developerName",
    );
  }
  const description = input.description ?? null;
  if (description !== null && (typeof description !== "string" || description.length > 255)) {
    throw new MetadataError(
      "INVALID_FIELD",
      "Description must be at most 255 characters.",
      "description",
    );
  }
  const picklists = await resolvePicklists(ctx, object, input.picklists, false);
  try {
    const rt = await ctx.tx
      .insertInto("record_type")
      .values({
        id: newId(KeyPrefix.RecordType),
        org_id: ctx.orgId,
        object_id: object.id,
        developer_name: developerName,
        label,
        description,
        is_active: input.isActive ?? true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writePicklists(ctx, rt.id, picklists);
    return rt;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MetadataError(
        "DUPLICATE_DEVELOPER_NAME",
        `${object.api_name} already has a record type named ${developerName}.`,
        "developerName",
      );
    }
    throw err;
  }
}

export async function updateRecordType(
  ctx: Ctx,
  objectApiName: string,
  developerName: string,
  patch: RecordTypePatch,
): Promise<RecordTypeRow> {
  const object = await getObject(ctx, objectApiName);
  const rt = await getRecordType(ctx, object, developerName);
  const changes: Record<string, unknown> = {};
  if (patch.label !== undefined) changes.label = checkLabel(patch.label, "label", 80);
  if (patch.description !== undefined) {
    if (
      patch.description !== null &&
      (typeof patch.description !== "string" || patch.description.length > 255)
    ) {
      throw new MetadataError(
        "INVALID_FIELD",
        "Description must be at most 255 characters.",
        "description",
      );
    }
    changes.description = patch.description || null;
  }
  if (patch.isActive !== undefined) changes.is_active = patch.isActive;
  if (patch.picklists)
    await writePicklists(ctx, rt.id, await resolvePicklists(ctx, object, patch.picklists, true));
  if (Object.keys(changes).length === 0) return rt;
  return ctx.tx
    .updateTable("record_type")
    .set({ ...changes, updated_at: sql`now()` })
    .where("id", "=", rt.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Deletes a record type. Records that use it (including any in the recycle
 * bin) must be moved to another active record type with `replaceWith`.
 */
export async function deleteRecordType(
  ctx: Ctx,
  objectApiName: string,
  developerName: string,
  { replaceWith }: { replaceWith?: string } = {},
): Promise<{ recordsChanged: number }> {
  const object = await getObject(ctx, objectApiName);
  const rt = await getRecordType(ctx, object, developerName);
  const { n } = await ctx.tx
    .selectFrom("record")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("record_type_id", "=", rt.id)
    .executeTakeFirstOrThrow();
  if (n > 0) {
    if (replaceWith === undefined) {
      throw new MetadataError(
        "FIELD_INTEGRITY_EXCEPTION",
        `${n} record${n === 1 ? " uses" : "s use"} ${rt.developer_name}. Give replaceWith: another record type to move them to.`,
        "replaceWith",
      );
    }
    const target = await getRecordType(ctx, object, replaceWith);
    if (target.id === rt.id || !target.is_active) {
      throw new MetadataError(
        "INVALID_FIELD",
        "The replacement must be a different, active record type.",
        "replaceWith",
      );
    }
    await ctx.tx
      .updateTable("record")
      .set({ record_type_id: target.id })
      .where("record_type_id", "=", rt.id)
      .execute();
  }
  await ctx.tx.deleteFrom("record_type").where("id", "=", rt.id).execute();
  return { recordsChanged: n };
}
