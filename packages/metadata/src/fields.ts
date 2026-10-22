import { KeyPrefix, newId } from "@crm/db";
import { sql } from "kysely";
import { MetadataError, isUniqueViolation } from "./errors.js";
import {
  type FieldType,
  type PicklistValue,
  type PicklistValueInput,
  TYPE_SPECS,
  isFieldType,
  parsePicklistValues,
  parseProps,
} from "./field-types.js";
import { LIMITS } from "./limits.js";
import {
  type Ctx,
  type FieldRow,
  type ObjectRow,
  findField,
  getField,
  getObject,
} from "./model.js";
import {
  SYSTEM_FIELD_NAMES,
  checkLabel,
  customApiName,
  nameFromLabel,
  relationshipBaseName,
  sameName,
  standardApiName,
} from "./names.js";

export type FieldInput = {
  type: FieldType;
  /** "Region" or "Region__c"; derived from the label when omitted. */
  apiName?: string;
  label: string;
  description?: string;
  helpText?: string;
  required?: boolean;
  unique?: boolean;
  externalId?: boolean;
  /** Picklist and MultiselectPicklist. */
  values?: PicklistValueInput[];
  /** Lookup and MasterDetail: the API name of the parent object. */
  referenceTo?: string;
  /** Name the parent uses to list these children, e.g. "Invoices". Defaults to this object's plural label. */
  relationshipName?: string;
  /** Title of the related list on the parent. Defaults to this object's plural label. */
  relationshipLabel?: string;
  /** Lookup only: what happens to this field when the parent is deleted. */
  deleteConstraint?: "SetNull" | "Restrict";
  /** Type-specific settings: length, precision, scale, displayFormat, ... */
  [setting: string]: unknown;
};

export type FieldPatch = Partial<Omit<FieldInput, "values">> & { [setting: string]: unknown };

const COMMON_KEYS = new Set([
  "type",
  "apiName",
  "label",
  "description",
  "helpText",
  "required",
  "unique",
  "externalId",
  "values",
  "referenceTo",
  "relationshipName",
  "relationshipLabel",
  "deleteConstraint",
]);

function splitSettings(input: Record<string, unknown>): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input))
    if (!COMMON_KEYS.has(k) && v !== undefined) settings[k] = v;
  return settings;
}

function optionalText(v: unknown, max: number, path: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max) {
    throw new MetadataError("INVALID_FIELD", `${path} must be at most ${max} characters.`, path);
  }
  return v;
}

function bool(v: unknown, path: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean")
    throw new MetadataError("INVALID_FIELD", `${path} must be true or false.`, path);
  return v;
}

/** Checks required / unique / external ID against what the type allows. */
function checkFlags(
  type: FieldType,
  flags: { required: boolean; unique: boolean; externalId: boolean },
  props: Record<string, unknown>,
): void {
  const spec = TYPE_SPECS[type];
  if (flags.required && !spec.canBeRequired && type !== "MasterDetail") {
    const why =
      type === "Checkbox"
        ? "A checkbox always has a value."
        : type === "AutoNumber"
          ? "Auto numbers are always filled in by the system."
          : "";
    throw new MetadataError(
      "INVALID_FIELD",
      `${type} fields can't be required. ${why}`.trim(),
      "required",
    );
  }
  if (flags.unique && !spec.canBeUnique) {
    throw new MetadataError("INVALID_FIELD", `${type} fields can't be unique.`, "unique");
  }
  if (flags.externalId && !spec.canBeExternalId) {
    throw new MetadataError("INVALID_FIELD", `${type} fields can't be external IDs.`, "externalId");
  }
  if (type === "Text" && props.caseSensitive === true && !flags.unique) {
    throw new MetadataError(
      "INVALID_FIELD",
      "Case-sensitive applies only to unique text fields.",
      "caseSensitive",
    );
  }
}

async function countFields(
  ctx: Ctx,
  objectId: string,
  filter: "custom" | "relationship" | "masterDetail" | "externalId",
): Promise<number> {
  let q = ctx.tx
    .selectFrom("field_def")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("object_id", "=", objectId);
  if (filter === "custom") q = q.where("is_custom", "=", true);
  if (filter === "relationship") q = q.where("type", "in", ["Lookup", "MasterDetail"]);
  if (filter === "masterDetail") q = q.where("type", "=", "MasterDetail");
  if (filter === "externalId") q = q.where("is_external_id", "=", true);
  return (await q.executeTakeFirstOrThrow()).n;
}

/**
 * Master-detail chains may be at most three levels deep and can't loop.
 * Adding child -> parent joins the chain above the parent to the chain
 * below the child.
 */
async function checkMasterDetailChain(
  ctx: Ctx,
  child: ObjectRow,
  parent: ObjectRow,
): Promise<void> {
  const edges = await ctx.tx
    .selectFrom("field_def")
    .select(["object_id", "reference_to"])
    .where("type", "=", "MasterDetail")
    .execute();
  const masters = new Map<string, string[]>();
  const details = new Map<string, string[]>();
  for (const e of edges) {
    if (!e.reference_to) continue;
    masters.set(e.object_id, [...(masters.get(e.object_id) ?? []), e.reference_to]);
    details.set(e.reference_to, [...(details.get(e.reference_to) ?? []), e.object_id]);
  }
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const m of masters.get(id) ?? []) {
      if (!seen.has(m)) {
        seen.add(m);
        ancestors(m, seen);
      }
    }
    return seen;
  };
  if (ancestors(parent.id).has(child.id)) {
    throw new MetadataError(
      "FIELD_INTEGRITY_EXCEPTION",
      `${parent.api_name} is already a detail of ${child.api_name}, so it can't also be its master.`,
      "referenceTo",
    );
  }
  const depthAbove = (id: string): number =>
    1 + Math.max(0, ...(masters.get(id) ?? []).map(depthAbove));
  const heightBelow = (id: string): number =>
    1 + Math.max(0, ...(details.get(id) ?? []).map(heightBelow));
  const levels = depthAbove(parent.id) + heightBelow(child.id);
  if (levels > LIMITS.masterDetailDepth) {
    throw new MetadataError(
      "LIMIT_EXCEEDED",
      `Master-detail relationships can be at most ${LIMITS.masterDetailDepth} levels deep; this would make ${levels}.`,
      "referenceTo",
    );
  }
}

type Relationship = {
  reference_to: string;
  relationship_name: string;
  relationship_label: string;
  delete_constraint: "SetNull" | "Restrict" | "Cascade";
};

async function resolveRelationship(
  ctx: Ctx,
  object: ObjectRow,
  type: "Lookup" | "MasterDetail",
  input: FieldInput,
  required: boolean,
): Promise<Relationship> {
  if (typeof input.referenceTo !== "string" || !input.referenceTo) {
    throw new MetadataError(
      "INVALID_FIELD",
      `A ${type} field needs referenceTo: the object it points to.`,
      "referenceTo",
    );
  }
  const parent = await getObject(ctx, input.referenceTo).catch(() => {
    throw new MetadataError(
      "NOT_FOUND",
      `There's no object named ${input.referenceTo}.`,
      "referenceTo",
    );
  });

  let deleteConstraint: Relationship["delete_constraint"];
  if (type === "MasterDetail") {
    if (input.deleteConstraint !== undefined) {
      throw new MetadataError(
        "INVALID_FIELD",
        "Master-detail children are always deleted with their parent; deleteConstraint doesn't apply.",
        "deleteConstraint",
      );
    }
    if (parent.storage === "platform") {
      throw new MetadataError(
        "FIELD_INTEGRITY_EXCEPTION",
        `A master-detail field can't point to ${parent.api_name}.`,
        "referenceTo",
      );
    }
    if (parent.id === object.id) {
      throw new MetadataError(
        "FIELD_INTEGRITY_EXCEPTION",
        "An object can't be its own master.",
        "referenceTo",
      );
    }
    if ((await countFields(ctx, object.id, "masterDetail")) >= LIMITS.masterDetailPerObject) {
      throw new MetadataError(
        "LIMIT_EXCEEDED",
        `An object can have at most ${LIMITS.masterDetailPerObject} master-detail fields.`,
        "type",
      );
    }
    await checkMasterDetailChain(ctx, object, parent);
    deleteConstraint = "Cascade";
  } else {
    const dc = input.deleteConstraint ?? (required ? "Restrict" : "SetNull");
    if (dc !== "SetNull" && dc !== "Restrict") {
      throw new MetadataError(
        "INVALID_FIELD",
        "deleteConstraint must be SetNull or Restrict.",
        "deleteConstraint",
      );
    }
    if (required && dc === "SetNull") {
      throw new MetadataError(
        "INVALID_FIELD",
        "A required lookup can't be cleared when its parent is deleted. Use Restrict.",
        "deleteConstraint",
      );
    }
    deleteConstraint = dc;
  }

  if ((await countFields(ctx, object.id, "relationship")) >= LIMITS.relationshipFieldsPerObject) {
    throw new MetadataError(
      "LIMIT_EXCEEDED",
      `An object can have at most ${LIMITS.relationshipFieldsPerObject} relationship fields.`,
      "type",
    );
  }

  const relationshipName = relationshipBaseName(
    typeof input.relationshipName === "string"
      ? input.relationshipName
      : nameFromLabel(object.plural_label),
  );
  await checkChildRelationshipFree(ctx, parent, relationshipName, null);
  const relationshipLabel = checkLabel(
    typeof input.relationshipLabel === "string" ? input.relationshipLabel : object.plural_label,
    "relationshipLabel",
    80,
  );
  return {
    reference_to: parent.id,
    relationship_name: relationshipName,
    relationship_label: relationshipLabel,
    delete_constraint: deleteConstraint,
  };
}

async function checkChildRelationshipFree(
  ctx: Ctx,
  parent: ObjectRow,
  name: string,
  exceptFieldId: string | null,
): Promise<void> {
  let q = ctx.tx
    .selectFrom("field_def")
    .select("id")
    .where("reference_to", "=", parent.id)
    .where(sql`lower(relationship_name)`, "=", name.toLowerCase());
  if (exceptFieldId) q = q.where("id", "<>", exceptFieldId);
  if (await q.executeTakeFirst()) {
    throw new MetadataError(
      "DUPLICATE_DEVELOPER_NAME",
      `${parent.api_name} already has a child relationship named ${name}. Choose another relationship name.`,
      "relationshipName",
    );
  }
}

async function insertPicklistValues(
  ctx: Ctx,
  object: ObjectRow,
  fieldId: string,
  values: PicklistValue[],
  startOrder: number,
  addToRecordTypes: boolean,
): Promise<void> {
  if (values.length === 0) return;
  await ctx.tx
    .insertInto("picklist_value")
    .values(
      values.map((v, i) => ({
        org_id: ctx.orgId,
        field_id: fieldId,
        value: v.value,
        label: v.label,
        sort_order: startOrder + i,
        is_default: v.isDefault,
        is_active: true,
      })),
    )
    .execute();
  if (!addToRecordTypes) return;
  const recordTypes = await ctx.tx
    .selectFrom("record_type")
    .select("id")
    .where("object_id", "=", object.id)
    .execute();
  if (recordTypes.length === 0) return;
  await ctx.tx
    .insertInto("record_type_picklist_value")
    .values(
      recordTypes.flatMap((rt) =>
        values.map((v) => ({
          org_id: ctx.orgId,
          record_type_id: rt.id,
          field_id: fieldId,
          value: v.value,
          is_default: false,
        })),
      ),
    )
    .execute();
}

export type CreateFieldOptions = {
  /** Platform seeding only (step 11): a standard field such as AccountId or Industry. */
  standard?: boolean;
};

export async function createField(
  ctx: Ctx,
  objectApiName: string,
  input: FieldInput,
  options: CreateFieldOptions = {},
): Promise<FieldRow> {
  const object = await getObject(ctx, objectApiName);
  if (object.storage === "platform") {
    throw new MetadataError(
      "NOT_SUPPORTED",
      `Fields can't be added to the built-in ${object.api_name} object yet.`,
    );
  }
  if (!isFieldType(input.type)) {
    throw new MetadataError("INVALID_FIELD", `Unknown field type ${String(input.type)}.`, "type");
  }
  const type = input.type;
  const label = checkLabel(input.label, "label");

  let apiName: string;
  if (options.standard) {
    apiName = standardApiName(input.apiName ?? nameFromLabel(label).replace(/_/g, ""));
    if (SYSTEM_FIELD_NAMES.has(apiName.toLowerCase()) || sameName(apiName, "Name")) {
      throw new MetadataError("INVALID_NAME", `${apiName} is a system field name.`, "apiName");
    }
    if (TYPE_SPECS[type].isRelationship && !apiName.endsWith("Id")) {
      throw new MetadataError(
        "INVALID_NAME",
        "Standard relationship fields end in Id, e.g. AccountId.",
        "apiName",
      );
    }
  } else {
    apiName = customApiName(input.apiName ?? nameFromLabel(label));
  }
  if (await findField(ctx, object.id, apiName)) {
    throw new MetadataError(
      "DUPLICATE_DEVELOPER_NAME",
      `${object.api_name} already has a field named ${apiName}.`,
      "apiName",
    );
  }

  const props = parseProps(type, splitSettings(input));
  const required = type === "MasterDetail" ? true : (bool(input.required, "required") ?? false);
  const unique = bool(input.unique, "unique") ?? false;
  const externalId = bool(input.externalId, "externalId") ?? false;
  if (type === "MasterDetail" && input.required === false) {
    throw new MetadataError(
      "INVALID_FIELD",
      "Master-detail fields are always required.",
      "required",
    );
  }
  checkFlags(type, { required, unique, externalId }, props);
  const description = optionalText(input.description, 1000, "description");
  const helpText = optionalText(input.helpText, 510, "helpText");

  if (
    !options.standard &&
    (await countFields(ctx, object.id, "custom")) >= LIMITS.customFieldsPerObject
  ) {
    throw new MetadataError(
      "LIMIT_EXCEEDED",
      `An object can have at most ${LIMITS.customFieldsPerObject} custom fields.`,
    );
  }
  if (
    externalId &&
    (await countFields(ctx, object.id, "externalId")) >= LIMITS.externalIdsPerObject
  ) {
    throw new MetadataError(
      "LIMIT_EXCEEDED",
      `An object can have at most ${LIMITS.externalIdsPerObject} external ID fields.`,
      "externalId",
    );
  }

  const relationship =
    type === "Lookup" || type === "MasterDetail"
      ? await resolveRelationship(ctx, object, type, input, required)
      : null;
  if (!relationship) {
    for (const key of [
      "referenceTo",
      "relationshipName",
      "relationshipLabel",
      "deleteConstraint",
    ] as const) {
      if (input[key] !== undefined) {
        throw new MetadataError(
          "INVALID_FIELD",
          `${key} applies only to Lookup and MasterDetail fields.`,
          key,
        );
      }
    }
  }

  let values: PicklistValue[] = [];
  if (TYPE_SPECS[type].isPicklist) {
    values = parsePicklistValues(type, input.values);
  } else if (input.values !== undefined) {
    throw new MetadataError("INVALID_FIELD", "values applies only to picklist fields.", "values");
  }

  try {
    const field = (await ctx.tx
      .insertInto("field_def")
      .values({
        id: newId(KeyPrefix.FieldDef),
        org_id: ctx.orgId,
        object_id: object.id,
        api_name: apiName,
        label,
        type,
        is_custom: !options.standard,
        is_name_field: false,
        required,
        is_unique: unique,
        is_external_id: externalId,
        description,
        help_text: helpText,
        props: JSON.stringify(props),
        reference_to: relationship?.reference_to ?? null,
        relationship_name: relationship?.relationship_name ?? null,
        relationship_label: relationship?.relationship_label ?? null,
        delete_constraint: relationship?.delete_constraint ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()) as FieldRow;
    await insertPicklistValues(ctx, object, field.id, values, 0, true);
    if (type === "MasterDetail") {
      await ctx.tx
        .updateTable("object_def")
        .set({ sharing_model: "ControlledByParent", updated_at: sql`now()` })
        .where("id", "=", object.id)
        .execute();
    }
    return field;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MetadataError(
        "DUPLICATE_DEVELOPER_NAME",
        "A field with that API name or relationship name was just created by someone else. Try again.",
        "apiName",
      );
    }
    throw err;
  }
}

/**
 * Changes a field's settings. The type can't change (delete and recreate the
 * field), except that an object's Name field can switch between Text and
 * AutoNumber, as in Salesforce.
 */
export async function updateField(
  ctx: Ctx,
  objectApiName: string,
  fieldApiName: string,
  patch: FieldPatch,
): Promise<FieldRow> {
  const object = await getObject(ctx, objectApiName);
  const field = await getField(ctx, object, fieldApiName);
  if (object.storage === "platform") {
    throw new MetadataError(
      "NOT_SUPPORTED",
      `Fields of the built-in ${object.api_name} object can't be changed.`,
    );
  }
  if (patch.values !== undefined) {
    throw new MetadataError(
      "INVALID_FIELD",
      "Change picklist values with the picklist value operations.",
      "values",
    );
  }

  let type = field.type;
  if (patch.type !== undefined && patch.type !== field.type) {
    const switchingName =
      field.is_name_field && (patch.type === "Text" || patch.type === "AutoNumber");
    if (!switchingName) {
      throw new MetadataError(
        "INVALID_TYPE_CHANGE",
        `Changing a field from ${field.type} to ${String(patch.type)} isn't supported. Create a new field instead.`,
        "type",
      );
    }
    type = patch.type as FieldType;
  }
  if (patch.referenceTo !== undefined) {
    const current = field.reference_to
      ? await ctx.tx
          .selectFrom("object_def")
          .select("api_name")
          .where("id", "=", field.reference_to)
          .executeTakeFirst()
      : undefined;
    if (!current || !sameName(current.api_name, String(patch.referenceTo))) {
      throw new MetadataError(
        "INVALID_TYPE_CHANGE",
        "A relationship can't be pointed at a different object. Create a new field instead.",
        "referenceTo",
      );
    }
  }

  const standardOnly = !field.is_custom;
  const allowedForStandard = new Set(["label", "description", "helpText", "type", "referenceTo"]);
  if (field.is_name_field) {
    for (const k of ["length", "displayFormat", "startingNumber"]) allowedForStandard.add(k);
  }
  if (standardOnly) {
    const blocked = Object.keys(patch).filter(
      (k) => patch[k] !== undefined && !allowedForStandard.has(k),
    );
    if (blocked.length) {
      throw new MetadataError(
        "NOT_SUPPORTED",
        `On standard field ${field.api_name} you can change only the label, description and help text.`,
        blocked[0],
      );
    }
  }

  const changes: Record<string, unknown> = {};
  if (patch.label !== undefined) changes.label = checkLabel(patch.label, "label");
  if (patch.description !== undefined)
    changes.description = optionalText(patch.description, 1000, "description");
  if (patch.helpText !== undefined)
    changes.help_text = optionalText(patch.helpText, 510, "helpText");
  if (patch.apiName !== undefined) {
    const renamed = customApiName(String(patch.apiName));
    const clash = await findField(ctx, object.id, renamed);
    if (clash && clash.id !== field.id) {
      throw new MetadataError(
        "DUPLICATE_DEVELOPER_NAME",
        `${object.api_name} already has a field named ${renamed}.`,
        "apiName",
      );
    }
    changes.api_name = renamed;
  }

  // Settings: start from the stored ones (unless the type changed), apply the patch, revalidate.
  const settingsPatch = splitSettings(patch);
  const baseProps: Record<string, unknown> = type === field.type ? { ...field.props } : {};
  // A Name field switched from AutoNumber starts as Text(80), Salesforce's default.
  if (field.is_name_field && type === "Text") baseProps.length = baseProps.length ?? 80;
  const props = parseProps(type, { ...baseProps, ...settingsPatch });
  if (field.is_name_field && type === "Text" && Number(props.length) > 80) {
    throw new MetadataError(
      "INVALID_FIELD",
      "A Name field can be at most 80 characters long.",
      "length",
    );
  }
  if (type !== field.type || Object.keys(settingsPatch).length > 0)
    changes.props = JSON.stringify(props);
  if (type !== field.type) changes.type = type;

  const required = field.is_name_field
    ? true
    : type === "MasterDetail"
      ? true
      : (bool(patch.required, "required") ?? field.required);
  if (type === "MasterDetail" && patch.required === false) {
    throw new MetadataError(
      "INVALID_FIELD",
      "Master-detail fields are always required.",
      "required",
    );
  }
  const unique = bool(patch.unique, "unique") ?? field.is_unique;
  const externalId = bool(patch.externalId, "externalId") ?? field.is_external_id;
  if (!field.is_name_field) checkFlags(type, { required, unique, externalId }, props);
  if (
    externalId &&
    !field.is_external_id &&
    (await countFields(ctx, object.id, "externalId")) >= LIMITS.externalIdsPerObject
  ) {
    throw new MetadataError(
      "LIMIT_EXCEEDED",
      `An object can have at most ${LIMITS.externalIdsPerObject} external ID fields.`,
      "externalId",
    );
  }
  if (required !== field.required) changes.required = required;
  if (unique !== field.is_unique) changes.is_unique = unique;
  if (externalId !== field.is_external_id) changes.is_external_id = externalId;

  if (type === "Lookup" || type === "MasterDetail") {
    if (patch.deleteConstraint !== undefined && type === "MasterDetail") {
      throw new MetadataError(
        "INVALID_FIELD",
        "Master-detail children are always deleted with their parent.",
        "deleteConstraint",
      );
    }
    const dc = patch.deleteConstraint ?? field.delete_constraint;
    if (type === "Lookup") {
      if (dc !== "SetNull" && dc !== "Restrict") {
        throw new MetadataError(
          "INVALID_FIELD",
          "deleteConstraint must be SetNull or Restrict.",
          "deleteConstraint",
        );
      }
      if (required && dc === "SetNull") {
        throw new MetadataError(
          "INVALID_FIELD",
          "A required lookup can't be cleared when its parent is deleted. Set deleteConstraint to Restrict.",
          "deleteConstraint",
        );
      }
      if (dc !== field.delete_constraint) changes.delete_constraint = dc;
    }
    if (patch.relationshipName !== undefined) {
      const name = relationshipBaseName(String(patch.relationshipName));
      const parent = await ctx.tx
        .selectFrom("object_def")
        .selectAll()
        .where("id", "=", field.reference_to ?? "")
        .executeTakeFirstOrThrow();
      await checkChildRelationshipFree(ctx, parent, name, field.id);
      changes.relationship_name = name;
    }
    if (patch.relationshipLabel !== undefined) {
      changes.relationship_label = checkLabel(patch.relationshipLabel, "relationshipLabel", 80);
    }
  } else {
    for (const key of ["relationshipName", "relationshipLabel", "deleteConstraint"] as const) {
      if (patch[key] !== undefined) {
        throw new MetadataError(
          "INVALID_FIELD",
          `${key} applies only to Lookup and MasterDetail fields.`,
          key,
        );
      }
    }
  }

  if (Object.keys(changes).length === 0) return field;
  try {
    return (await ctx.tx
      .updateTable("field_def")
      .set({ ...changes, updated_at: sql`now()` })
      .where("id", "=", field.id)
      .returningAll()
      .executeTakeFirstOrThrow()) as FieldRow;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MetadataError(
        "DUPLICATE_DEVELOPER_NAME",
        "That name was just taken. Try another.",
        "apiName",
      );
    }
    throw err;
  }
}

export async function deleteField(
  ctx: Ctx,
  objectApiName: string,
  fieldApiName: string,
): Promise<void> {
  const object = await getObject(ctx, objectApiName);
  const field = await getField(ctx, object, fieldApiName);
  if (field.is_name_field) {
    throw new MetadataError(
      "CANNOT_DELETE",
      "Every object needs its Name field; it can't be deleted.",
    );
  }
  if (!field.is_custom) {
    throw new MetadataError(
      "CANNOT_DELETE",
      `${field.api_name} is a standard field and can't be deleted.`,
    );
  }
  await ctx.tx.deleteFrom("field_def").where("id", "=", field.id).execute();
  if (field.type === "MasterDetail" && (await countFields(ctx, object.id, "masterDetail")) === 0) {
    // No parent controls sharing any more; fall back to the open default.
    await ctx.tx
      .updateTable("object_def")
      .set({ sharing_model: "ReadWrite", updated_at: sql`now()` })
      .where("id", "=", object.id)
      .execute();
  }
}

export { insertPicklistValues };
