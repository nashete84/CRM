import { sql } from "kysely";
import { MetadataError } from "./errors.js";
import { type PicklistValueInput, TYPE_SPECS, parsePicklistValues } from "./field-types.js";
import { insertPicklistValues } from "./fields.js";
import { LIMITS } from "./limits.js";
import {
  type Ctx,
  type FieldRow,
  type ObjectRow,
  type PicklistRow,
  getField,
  getObject,
} from "./model.js";

async function picklistField(
  ctx: Ctx,
  objectApiName: string,
  fieldApiName: string,
): Promise<{ object: ObjectRow; field: FieldRow }> {
  const object = await getObject(ctx, objectApiName);
  const field = await getField(ctx, object, fieldApiName);
  if (!TYPE_SPECS[field.type].isPicklist) {
    throw new MetadataError(
      "INVALID_FIELD",
      `${object.api_name}.${field.api_name} isn't a picklist.`,
    );
  }
  if (object.storage === "platform") {
    throw new MetadataError(
      "NOT_SUPPORTED",
      `Fields of the built-in ${object.api_name} object can't be changed.`,
    );
  }
  return { object, field };
}

async function currentValues(ctx: Ctx, fieldId: string): Promise<PicklistRow[]> {
  return ctx.tx
    .selectFrom("picklist_value")
    .selectAll()
    .where("field_id", "=", fieldId)
    .orderBy("sort_order")
    .execute();
}

function findValue(values: PicklistRow[], value: string, field: FieldRow): PicklistRow {
  const found = values.find((v) => v.value.toLowerCase() === value.trim().toLowerCase());
  if (!found)
    throw new MetadataError("NOT_FOUND", `${field.api_name} has no value "${value}".`, "value");
  return found;
}

async function clearDefault(ctx: Ctx, fieldId: string): Promise<void> {
  await ctx.tx
    .updateTable("picklist_value")
    .set({ is_default: false })
    .where("field_id", "=", fieldId)
    .where("is_default", "=", true)
    .execute();
}

/**
 * Appends values. By default they're also offered by every record type of the
 * object, matching Salesforce's "add to all record types" choice.
 */
export async function addPicklistValues(
  ctx: Ctx,
  objectApiName: string,
  fieldApiName: string,
  input: PicklistValueInput[],
  { addToRecordTypes = true }: { addToRecordTypes?: boolean } = {},
): Promise<void> {
  const { object, field } = await picklistField(ctx, objectApiName, fieldApiName);
  const values = parsePicklistValues(field.type, input);
  const existing = await currentValues(ctx, field.id);
  if (existing.length + values.length > LIMITS.picklistValuesPerField) {
    throw new MetadataError(
      "LIMIT_EXCEEDED",
      `A picklist can have at most ${LIMITS.picklistValuesPerField} values.`,
      "values",
    );
  }
  const taken = new Set(existing.map((v) => v.value.toLowerCase()));
  const clash = values.find((v) => taken.has(v.value.toLowerCase()));
  if (clash) {
    throw new MetadataError(
      "DUPLICATE_DEVELOPER_NAME",
      `${field.api_name} already has the value "${clash.value}".`,
      "values",
    );
  }
  if (values.some((v) => v.isDefault)) await clearDefault(ctx, field.id);
  const nextOrder = Math.max(-1, ...existing.map((v) => v.sort_order)) + 1;
  await insertPicklistValues(ctx, object, field.id, values, nextOrder, addToRecordTypes);
}

export type PicklistValuePatch = {
  /** Renames the stored value (its API name). Record data follows from step 4. */
  newValue?: string;
  label?: string;
  isActive?: boolean;
  isDefault?: boolean;
};

export async function updatePicklistValue(
  ctx: Ctx,
  objectApiName: string,
  fieldApiName: string,
  value: string,
  patch: PicklistValuePatch,
): Promise<void> {
  const { field } = await picklistField(ctx, objectApiName, fieldApiName);
  const values = await currentValues(ctx, field.id);
  const row = findValue(values, value, field);

  const changes: Partial<{
    value: string;
    label: string;
    is_active: boolean;
    is_default: boolean;
  }> = {};
  if (patch.newValue !== undefined) {
    const [parsed] = parsePicklistValues(
      field.type,
      [{ value: patch.newValue, label: patch.label ?? row.label }],
      { path: "newValue" },
    );
    if (!parsed) throw new MetadataError("INVALID_FIELD", "newValue is required.", "newValue");
    const clash = values.find(
      (v) => v.value.toLowerCase() === parsed.value.toLowerCase() && v.value !== row.value,
    );
    if (clash) {
      throw new MetadataError(
        "DUPLICATE_DEVELOPER_NAME",
        `${field.api_name} already has the value "${clash.value}".`,
        "newValue",
      );
    }
    changes.value = parsed.value;
  }
  if (patch.label !== undefined) {
    if (typeof patch.label !== "string" || !patch.label.trim() || patch.label.length > 255) {
      throw new MetadataError("INVALID_FIELD", "Label must be 1 to 255 characters.", "label");
    }
    changes.label = patch.label.trim();
  }
  const active = patch.isActive ?? row.is_active;
  if (!active && values.filter((v) => v.is_active && v.value !== row.value).length === 0) {
    throw new MetadataError(
      "INVALID_FIELD",
      "A picklist needs at least one active value.",
      "isActive",
    );
  }
  if (patch.isDefault === true && !active) {
    throw new MetadataError(
      "INVALID_FIELD",
      "An inactive value can't be the default.",
      "isDefault",
    );
  }
  if (patch.isActive !== undefined) changes.is_active = patch.isActive;
  if (patch.isDefault !== undefined) changes.is_default = patch.isDefault;
  if (!active) changes.is_default = false;

  if (changes.is_default === true) await clearDefault(ctx, field.id);
  await ctx.tx
    .updateTable("picklist_value")
    .set(changes)
    .where("field_id", "=", field.id)
    .where("value", "=", row.value)
    .execute();
  if (!active) {
    // An inactive value can't be a record type's default either.
    await ctx.tx
      .updateTable("record_type_picklist_value")
      .set({ is_default: false })
      .where("field_id", "=", field.id)
      .where("value", "=", changes.value ?? row.value)
      .execute();
  }
}

/** Removes a value outright. Records that use it are handled from step 4. */
export async function deletePicklistValue(
  ctx: Ctx,
  objectApiName: string,
  fieldApiName: string,
  value: string,
): Promise<void> {
  const { field } = await picklistField(ctx, objectApiName, fieldApiName);
  const values = await currentValues(ctx, field.id);
  const row = findValue(values, value, field);
  if (values.filter((v) => v.is_active && v.value !== row.value).length === 0) {
    throw new MetadataError(
      "CANNOT_DELETE",
      "A picklist needs at least one active value.",
      "value",
    );
  }
  await ctx.tx
    .deleteFrom("picklist_value")
    .where("field_id", "=", field.id)
    .where("value", "=", row.value)
    .execute();
}

/** Moves values into the given order; values not listed keep their relative order after them. */
export async function reorderPicklistValues(
  ctx: Ctx,
  objectApiName: string,
  fieldApiName: string,
  order: string[],
): Promise<void> {
  const { field } = await picklistField(ctx, objectApiName, fieldApiName);
  const values = await currentValues(ctx, field.id);
  const listed = order.map((v) => findValue(values, v, field));
  const rest = values.filter((v) => !listed.includes(v));
  const final = [...listed, ...rest];
  for (const [i, v] of final.entries()) {
    await ctx.tx
      .updateTable("picklist_value")
      .set({ sort_order: sql`${i}` })
      .where("field_id", "=", field.id)
      .where("value", "=", v.value)
      .execute();
  }
}
