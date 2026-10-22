import { type RecordTable, newId, normalizeId } from "@crm/db";
import {
  type FieldRow,
  MASTER_RECORD_TYPE_ID,
  type ObjectMeta,
  type StoredValue,
  ValueError,
  formatAutoNumber,
  indexKey,
  isIndexed,
  toStored,
} from "@crm/metadata";
import { type Selectable, sql } from "kysely";
import { type RecordCtx, fieldMap, loadMeta, nameField } from "./context.js";
import { RecordError, type RecordErrorItem } from "./errors.js";

export type RecordInput = Record<string, unknown>;
export type RecordRow = Selectable<RecordTable>;

/** System fields the platform maintains; callers can't set them. */
const READ_ONLY = new Set(
  [
    "Id",
    "IsDeleted",
    "CreatedDate",
    "CreatedById",
    "LastModifiedDate",
    "LastModifiedById",
    "SystemModstamp",
  ].map((s) => s.toLowerCase()),
);

type Prepared = {
  /** Values of the Name field (column) and of other fields (data), by field id. null clears. */
  name: StoredValue | null | undefined;
  data: Map<string, StoredValue | null>;
  ownerId: string | null | undefined;
  recordTypeId: string | null | undefined;
};

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

export async function getRow(ctx: RecordCtx, meta: ObjectMeta, id: string): Promise<RecordRow> {
  const canonical = typeof id === "string" ? normalizeId(id.trim()) : null;
  if (!canonical || !canonical.startsWith(meta.object.key_prefix)) {
    throw RecordError.of("MALFORMED_ID", `Invalid ${meta.object.api_name} id: ${String(id)}`);
  }
  const row = await ctx.tx
    .selectFrom("record")
    .selectAll()
    .where("id", "=", canonical)
    .where("object_id", "=", meta.object.id)
    .executeTakeFirst();
  if (!row)
    throw RecordError.of(
      "NOT_FOUND",
      `The requested ${meta.object.api_name} ${canonical} does not exist.`,
    );
  return row;
}

function storedOf(row: RecordRow | undefined, field: FieldRow): StoredValue | null {
  if (!row) return null;
  if (field.is_name_field) return row.name;
  const v = (row.data as Record<string, unknown>)[field.id];
  return typeof v === "string" || typeof v === "boolean" ? v : null;
}

/** Reads the caller's values: known fields only, writable ones only, each valid for its type. */
function prepare(
  meta: ObjectMeta,
  input: RecordInput,
  existing: RecordRow | undefined,
  errors: RecordErrorItem[],
): Prepared {
  const byName = fieldMap(meta);
  const prepared: Prepared = {
    name: undefined,
    data: new Map(),
    ownerId: undefined,
    recordTypeId: undefined,
  };
  const type = meta.object.api_name;
  const controlledByParent = meta.object.sharing_model === "ControlledByParent";

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    errors.push({
      statusCode: "INVALID_FIELD",
      message: "Record values must be an object.",
      fields: [],
    });
    return prepared;
  }

  for (const [key, value] of Object.entries(input)) {
    const k = key.toLowerCase();
    if (k === "attributes") continue; // Salesforce clients send { attributes: { type } } along
    if (READ_ONLY.has(k)) {
      errors.push({
        statusCode: "INVALID_FIELD_FOR_INSERT_UPDATE",
        message: `Unable to create/update fields: ${key}. The platform maintains this field.`,
        fields: [key],
      });
      continue;
    }
    if (k === "ownerid" && !controlledByParent) {
      prepared.ownerId = value === null || value === "" ? null : String(value);
      continue;
    }
    if (k === "recordtypeid" && meta.recordTypes.length > 0) {
      prepared.recordTypeId = value === null || value === "" ? null : String(value);
      continue;
    }
    const field = byName.get(k);
    if (!field) {
      errors.push({
        statusCode: "INVALID_FIELD",
        message: `No such column '${key}' on sobject of type ${type}.`,
        fields: [key],
      });
      continue;
    }
    if (field.type === "AutoNumber") {
      errors.push({
        statusCode: "INVALID_FIELD_FOR_INSERT_UPDATE",
        message: `Unable to create/update fields: ${field.api_name}. Auto numbers are assigned by the platform.`,
        fields: [field.api_name],
      });
      continue;
    }
    const current = storedOf(existing, field);
    try {
      const stored = toStored(field, value, {
        picklist: meta.picklistValues.get(field.id) ?? [],
        current,
        targetKeyPrefix: field.reference_to
          ? meta.references.get(field.reference_to)?.keyPrefix
          : undefined,
      });
      if (field.type === "MasterDetail" && existing && stored !== current) {
        errors.push({
          statusCode: "INVALID_FIELD_FOR_INSERT_UPDATE",
          message: `Unable to update ${field.api_name}: a detail record can't be moved to a different master.`,
          fields: [field.api_name],
        });
        continue;
      }
      if (field.is_name_field) prepared.name = stored;
      else prepared.data.set(field.id, stored);
    } catch (err) {
      if (err instanceof ValueError)
        errors.push({ statusCode: err.code, message: err.message, fields: [field.api_name] });
      else throw err;
    }
  }
  return prepared;
}

async function resolveRecordType(
  meta: ObjectMeta,
  prepared: Prepared,
  existing: RecordRow | undefined,
  errors: RecordErrorItem[],
): Promise<string | null> {
  const active = meta.recordTypes.filter((r) => r.is_active);
  if (prepared.recordTypeId === undefined) {
    // On create, the default is the first active record type (as describe reports it).
    return existing ? existing.record_type_id : (active[0]?.id ?? null);
  }
  if (prepared.recordTypeId === null)
    return existing ? existing.record_type_id : (active[0]?.id ?? null);
  const id = normalizeId(prepared.recordTypeId);
  if (id === MASTER_RECORD_TYPE_ID) return null;
  const rt = meta.recordTypes.find((r) => r.id === id);
  if (!rt || (!rt.is_active && rt.id !== existing?.record_type_id)) {
    errors.push({
      statusCode: "INVALID_CROSS_REFERENCE_KEY",
      message: `Record Type ID: this ID value isn't valid for the user: ${prepared.recordTypeId}`,
      fields: ["RecordTypeId"],
    });
    return existing?.record_type_id ?? null;
  }
  return rt.id;
}

async function resolveOwner(
  ctx: RecordCtx,
  prepared: Prepared,
  existing: RecordRow | undefined,
  meta: ObjectMeta,
  errors: RecordErrorItem[],
): Promise<string | null> {
  if (meta.object.sharing_model === "ControlledByParent") return null;
  if (prepared.ownerId === undefined) return existing ? existing.owner_id : ctx.userId;
  const id = prepared.ownerId ? normalizeId(prepared.ownerId) : null;
  if (!id || !id.startsWith("005")) {
    errors.push({
      statusCode: "MALFORMED_ID",
      message: `Owner ID: id value of incorrect type: ${prepared.ownerId}`,
      fields: ["OwnerId"],
    });
    return existing?.owner_id ?? ctx.userId;
  }
  if (id === existing?.owner_id) return id;
  const user = await ctx.tx
    .selectFrom("app_user")
    .select(["id", "is_active"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!user) {
    errors.push({
      statusCode: "INVALID_CROSS_REFERENCE_KEY",
      message: `Owner ID: invalid cross reference id ${id}`,
      fields: ["OwnerId"],
    });
  } else if (!user.is_active) {
    errors.push({
      statusCode: "INACTIVE_OWNER_OR_USER",
      message: "Operation performed with inactive user as owner.",
      fields: ["OwnerId"],
    });
  }
  return id;
}

/** Fills create-time defaults: checkbox defaults and picklist defaults for the record type. */
function applyDefaults(meta: ObjectMeta, prepared: Prepared, recordTypeId: string | null): void {
  for (const f of meta.fields) {
    if (f.is_name_field || prepared.data.has(f.id)) continue;
    if (f.type === "Checkbox") {
      prepared.data.set(f.id, (f.props as { defaultValue?: boolean }).defaultValue === true);
    } else if (f.type === "Picklist" || f.type === "MultiselectPicklist") {
      const offered = recordTypeId ? meta.recordTypeValues.get(recordTypeId)?.get(f.id) : undefined;
      const def = offered
        ? offered.find((v) => v.isDefault)?.value
        : meta.picklistValues.get(f.id)?.find((v) => v.is_default && v.is_active)?.value;
      if (def) prepared.data.set(f.id, def);
    }
  }
}

function checkRequired(
  meta: ObjectMeta,
  prepared: Prepared,
  existing: RecordRow | undefined,
  errors: RecordErrorItem[],
): void {
  const missing: string[] = [];
  for (const f of meta.fields) {
    if (!f.required || f.type === "AutoNumber" || f.type === "Checkbox") continue;
    const provided = f.is_name_field ? prepared.name : prepared.data.get(f.id);
    const finalValue = provided !== undefined ? provided : storedOf(existing, f);
    if (finalValue === null || finalValue === undefined) missing.push(f.api_name);
  }
  if (missing.length) {
    errors.push({
      statusCode: "REQUIRED_FIELD_MISSING",
      message: `Required fields are missing: [${missing.join(", ")}]`,
      fields: missing,
    });
  }
}

/** Every lookup and master-detail value must name an existing, undeleted record of the right object. */
async function checkReferences(
  ctx: RecordCtx,
  meta: ObjectMeta,
  prepared: Prepared,
  existing: RecordRow | undefined,
  errors: RecordErrorItem[],
): Promise<void> {
  const byTarget = new Map<string, { ids: Set<string>; fields: FieldRow[] }>();
  for (const f of meta.fields) {
    if (!f.reference_to) continue;
    const v = prepared.data.get(f.id);
    if (typeof v !== "string" || v === storedOf(existing, f)) continue;
    const entry = byTarget.get(f.reference_to) ?? { ids: new Set(), fields: [] };
    entry.ids.add(v);
    entry.fields.push(f);
    byTarget.set(f.reference_to, entry);
  }
  for (const [targetId, { ids, fields }] of byTarget) {
    const target = meta.references.get(targetId);
    const list = [...ids];
    const found = new Set(
      target?.storage === "platform"
        ? (await ctx.tx.selectFrom("app_user").select("id").where("id", "in", list).execute()).map(
            (r) => r.id,
          )
        : (
            await ctx.tx
              .selectFrom("record")
              .select("id")
              .where("id", "in", list)
              .where("object_id", "=", targetId)
              .where("is_deleted", "=", false)
              .execute()
          ).map((r) => r.id),
    );
    for (const f of fields) {
      const v = prepared.data.get(f.id) as string;
      if (!found.has(v)) {
        errors.push({
          statusCode: "INVALID_CROSS_REFERENCE_KEY",
          message: `${f.label}: invalid cross reference id ${v}`,
          fields: [f.api_name],
        });
      }
    }
  }
}

async function checkUnique(
  ctx: RecordCtx,
  meta: ObjectMeta,
  prepared: Prepared,
  selfId: string | null,
  errors: RecordErrorItem[],
): Promise<void> {
  for (const f of meta.fields) {
    if (!f.is_unique) continue;
    const v = f.is_name_field ? prepared.name : prepared.data.get(f.id);
    if (v === null || v === undefined) continue;
    let q = ctx.tx
      .selectFrom("record_index")
      .select("record_id")
      .where("field_id", "=", f.id)
      .where("value_key", "=", indexKey(f, v))
      .where("is_unique", "=", true)
      .where("is_active", "=", true);
    if (selfId) q = q.where("record_id", "<>", selfId);
    const clash = await q.executeTakeFirst();
    if (clash) {
      errors.push({
        statusCode: "DUPLICATE_VALUE",
        message: `duplicate value found: ${f.api_name} duplicates value on record with id: ${clash.record_id}`,
        fields: [f.api_name],
      });
    }
  }
}

/** Next number for an auto number field. The row lock makes concurrent inserts take turns. */
export async function nextAutoNumber(ctx: RecordCtx, field: FieldRow): Promise<string> {
  const props = field.props as { displayFormat: string; startingNumber: number };
  const row = await ctx.tx
    .insertInto("autonumber_counter")
    .values({ field_id: field.id, org_id: ctx.orgId, next_value: props.startingNumber + 1 })
    .onConflict((oc) =>
      oc.column("field_id").doUpdateSet({ next_value: sql`autonumber_counter.next_value + 1` }),
    )
    .returning(sql<string>`next_value - 1`.as("n"))
    .executeTakeFirstOrThrow();
  return formatAutoNumber(props.displayFormat, BigInt(row.n));
}

async function writeIndex(
  ctx: RecordCtx,
  meta: ObjectMeta,
  recordId: string,
  values: Map<string, StoredValue | null>,
): Promise<void> {
  const byId = new Map(meta.fields.map((f) => [f.id, f]));
  for (const [fieldId, value] of values) {
    const f = byId.get(fieldId);
    if (!f || !isIndexed(f)) continue;
    await ctx.tx
      .deleteFrom("record_index")
      .where("field_id", "=", fieldId)
      .where("record_id", "=", recordId)
      .execute();
    if (value === null) continue;
    await ctx.tx
      .insertInto("record_index")
      .values({
        org_id: ctx.orgId,
        field_id: fieldId,
        record_id: recordId,
        value_key: indexKey(f, value),
        is_unique: f.is_unique,
      })
      .execute();
  }
}

function fail(errors: RecordErrorItem[]): void {
  if (errors.length) throw new RecordError(errors);
}

async function saveGuarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw RecordError.of(
        "DUPLICATE_VALUE",
        "duplicate value found: another record was just saved with the same unique value.",
      );
    }
    throw err;
  }
}

export async function createRecord(
  ctx: RecordCtx,
  objectApiName: string,
  input: RecordInput,
): Promise<{ id: string }> {
  const meta = await loadMeta(ctx, objectApiName);
  return createWithMeta(ctx, meta, input);
}

async function createWithMeta(
  ctx: RecordCtx,
  meta: ObjectMeta,
  input: RecordInput,
): Promise<{ id: string }> {
  const errors: RecordErrorItem[] = [];
  const prepared = prepare(meta, input, undefined, errors);
  const recordTypeId = await resolveRecordType(meta, prepared, undefined, errors);
  const ownerId = await resolveOwner(ctx, prepared, undefined, meta, errors);
  applyDefaults(meta, prepared, recordTypeId);
  checkRequired(meta, prepared, undefined, errors);
  fail(errors);
  await checkReferences(ctx, meta, prepared, undefined, errors);
  await checkUnique(ctx, meta, prepared, null, errors);
  fail(errors);

  for (const f of meta.fields) {
    if (f.type !== "AutoNumber") continue;
    const n = await nextAutoNumber(ctx, f);
    if (f.is_name_field) prepared.name = n;
    else prepared.data.set(f.id, n);
  }

  const id = newId(meta.object.key_prefix);
  const data: Record<string, StoredValue> = {};
  for (const [k, v] of prepared.data) if (v !== null) data[k] = v;
  const name = nameField(meta);
  return saveGuarded(async () => {
    await ctx.tx
      .insertInto("record")
      .values({
        id,
        org_id: ctx.orgId,
        object_id: meta.object.id,
        name: typeof prepared.name === "string" ? prepared.name : null,
        owner_id: ownerId,
        record_type_id: recordTypeId,
        data: JSON.stringify(data),
        created_by_id: ctx.userId,
        last_modified_by_id: ctx.userId,
      })
      .execute();
    const indexed = new Map(prepared.data);
    if (isIndexed(name)) indexed.set(name.id, prepared.name ?? null);
    await writeIndex(ctx, meta, id, indexed);
    return { id };
  });
}

export async function updateRecord(
  ctx: RecordCtx,
  objectApiName: string,
  id: string,
  input: RecordInput,
): Promise<void> {
  const meta = await loadMeta(ctx, objectApiName);
  const existing = await getRow(ctx, meta, id);
  await updateWithMeta(ctx, meta, existing, input);
}

async function updateWithMeta(
  ctx: RecordCtx,
  meta: ObjectMeta,
  existing: RecordRow,
  input: RecordInput,
): Promise<void> {
  if (existing.is_deleted) {
    throw RecordError.of(
      "ENTITY_IS_DELETED",
      `entity is deleted: ${existing.id} is in the recycle bin.`,
    );
  }
  const errors: RecordErrorItem[] = [];
  const prepared = prepare(meta, input, existing, errors);
  const recordTypeId = await resolveRecordType(meta, prepared, existing, errors);
  const ownerId = await resolveOwner(ctx, prepared, existing, meta, errors);
  checkRequired(meta, prepared, existing, errors);
  fail(errors);
  await checkReferences(ctx, meta, prepared, existing, errors);
  await checkUnique(ctx, meta, prepared, existing.id, errors);
  fail(errors);

  const data = { ...(existing.data as Record<string, unknown>) };
  for (const [k, v] of prepared.data) {
    if (v === null) delete data[k];
    else data[k] = v;
  }
  const name = nameField(meta);
  await saveGuarded(async () => {
    await ctx.tx
      .updateTable("record")
      .set({
        ...(prepared.name !== undefined
          ? { name: typeof prepared.name === "string" ? prepared.name : null }
          : {}),
        owner_id: ownerId,
        record_type_id: recordTypeId,
        data: JSON.stringify(data),
        last_modified_at: sql`now()`,
        last_modified_by_id: ctx.userId,
        system_modstamp: sql`now()`,
      })
      .where("id", "=", existing.id)
      .execute();
    const indexed = new Map(prepared.data);
    if (prepared.name !== undefined && isIndexed(name)) indexed.set(name.id, prepared.name);
    await writeIndex(ctx, meta, existing.id, indexed);
  });
}

/**
 * Creates or updates the record whose external ID field has this value, the
 * main path for loading data from another system.
 */
export async function upsertRecord(
  ctx: RecordCtx,
  objectApiName: string,
  externalIdField: string,
  externalIdValue: unknown,
  input: RecordInput,
): Promise<{ id: string; created: boolean }> {
  const meta = await loadMeta(ctx, objectApiName);
  const field = fieldMap(meta).get(externalIdField.toLowerCase());
  if (!field || !field.is_external_id) {
    throw RecordError.of(
      "INVALID_FIELD",
      `${externalIdField} is not an external ID field of ${meta.object.api_name}.`,
      [externalIdField],
    );
  }
  let stored: StoredValue | null;
  try {
    stored = toStored(field, externalIdValue, { picklist: [] });
  } catch (err) {
    if (err instanceof ValueError) throw RecordError.of(err.code, err.message, [field.api_name]);
    throw err;
  }
  if (stored === null)
    throw RecordError.of(
      "REQUIRED_FIELD_MISSING",
      `An external ID value is required for ${field.api_name}.`,
      [field.api_name],
    );

  const matches = await ctx.tx
    .selectFrom("record_index")
    .select("record_id")
    .where("field_id", "=", field.id)
    .where("value_key", "=", indexKey(field, stored))
    .where("is_active", "=", true)
    .limit(2)
    .execute();
  if (matches.length > 1) {
    throw RecordError.of(
      "DUPLICATE_EXTERNAL_ID",
      `${field.api_name}: more than one record found for external id ${String(externalIdValue)}.`,
      [field.api_name],
    );
  }
  const values = { ...input };
  for (const k of Object.keys(values))
    if (k.toLowerCase() === field.api_name.toLowerCase()) delete values[k];
  const match = matches[0];
  if (match) {
    const existing = await getRow(ctx, meta, match.record_id);
    await updateWithMeta(ctx, meta, existing, values);
    return { id: existing.id, created: false };
  }
  if (field.type === "AutoNumber") {
    throw RecordError.of(
      "NOT_FOUND",
      `No ${meta.object.api_name} has ${field.api_name} = ${String(externalIdValue)}.`,
      [field.api_name],
    );
  }
  const { id } = await createWithMeta(ctx, meta, { ...values, [field.api_name]: externalIdValue });
  return { id, created: true };
}
