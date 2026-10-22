import { KeyPrefix, type SharingModel, newId } from "@crm/db";
import { sql } from "kysely";
import { MetadataError, isForeignKeyViolation, isUniqueViolation } from "./errors.js";
import { checkAutoNumberFormat } from "./field-types.js";
import { LIMITS } from "./limits.js";
import { type Ctx, type ObjectRow, findObject, getObject } from "./model.js";
import { checkLabel, customApiName, nameFromLabel, standardApiName } from "./names.js";

export type NameFieldInput = {
  label?: string;
  type?: "Text" | "AutoNumber";
  /** AutoNumber only, e.g. "INV-{0000}". */
  displayFormat?: string;
  startingNumber?: number;
};

export type CreateObjectInput = {
  /** "Invoice" or "Invoice__c"; derived from the label when omitted. */
  apiName?: string;
  label: string;
  pluralLabel: string;
  description?: string;
  /** Org-wide default for records of this object (enforced from step 5). */
  sharingModel?: Exclude<SharingModel, "ControlledByParent">;
  nameField?: NameFieldInput;
};

export type UpdateObjectInput = {
  apiName?: string;
  label?: string;
  pluralLabel?: string;
  description?: string | null;
  sharingModel?: Exclude<SharingModel, "ControlledByParent">;
};

const SETTABLE_SHARING = new Set(["Private", "Read", "ReadWrite"]);
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function checkDescription(d: unknown, path = "description"): string | null {
  if (d === undefined || d === null || d === "") return null;
  if (typeof d !== "string" || d.length > 1000) {
    throw new MetadataError("INVALID_FIELD", "Description must be at most 1000 characters.", path);
  }
  return d;
}

function checkSharing(s: unknown): Exclude<SharingModel, "ControlledByParent"> {
  if (typeof s !== "string" || !SETTABLE_SHARING.has(s)) {
    throw new MetadataError(
      "INVALID_FIELD",
      "Sharing model must be Private, Read or ReadWrite. Controlled by Parent is set by adding a master-detail field.",
      "sharingModel",
    );
  }
  return s as Exclude<SharingModel, "ControlledByParent">;
}

/** Custom objects get the next free prefix a00, a01, ... like Salesforce's a0X range. */
async function allocateKeyPrefix(ctx: Ctx): Promise<string> {
  const used = new Set(
    (
      await ctx.tx
        .selectFrom("object_def")
        .select("key_prefix")
        .where("key_prefix", "like", "a%")
        .execute()
    ).map((r) => r.key_prefix),
  );
  for (const a of BASE62) {
    for (const b of BASE62) {
      const candidate = `a${a}${b}`;
      if (!used.has(candidate)) return candidate;
    }
  }
  throw new MetadataError("LIMIT_EXCEEDED", "No key prefixes left for custom objects.");
}

function nameFieldProps(input: NameFieldInput): {
  type: "Text" | "AutoNumber";
  props: Record<string, unknown>;
} {
  const type = input.type ?? "Text";
  if (type === "Text") {
    if (input.displayFormat !== undefined || input.startingNumber !== undefined) {
      throw new MetadataError(
        "INVALID_FIELD",
        "Display format and starting number apply only to an Auto Number name field.",
        "nameField",
      );
    }
    return { type, props: { length: 80, caseSensitive: false } };
  }
  if (type !== "AutoNumber") {
    throw new MetadataError(
      "INVALID_FIELD",
      "The name field must be Text or AutoNumber.",
      "nameField.type",
    );
  }
  if (typeof input.displayFormat !== "string") {
    throw new MetadataError(
      "INVALID_FIELD",
      "An Auto Number name field needs a display format.",
      "nameField.displayFormat",
    );
  }
  checkAutoNumberFormat(input.displayFormat);
  const start = input.startingNumber ?? 1;
  if (!Number.isInteger(start) || start < 0 || start > 999_999_999) {
    throw new MetadataError(
      "INVALID_FIELD",
      "Starting number must be a whole number from 0 to 999,999,999.",
      "nameField.startingNumber",
    );
  }
  return { type, props: { displayFormat: input.displayFormat, startingNumber: start } };
}

export type CreateObjectOptions = {
  /** Platform seeding only (step 11): a standard object with a fixed key prefix. */
  standard?: { keyPrefix: string };
};

export async function createObject(
  ctx: Ctx,
  input: CreateObjectInput,
  options: CreateObjectOptions = {},
): Promise<ObjectRow> {
  const label = checkLabel(input.label, "label");
  const pluralLabel = checkLabel(input.pluralLabel, "pluralLabel");
  const description = checkDescription(input.description);
  const sharingModel = checkSharing(input.sharingModel ?? "ReadWrite");
  const standard = options.standard;
  const apiName = standard
    ? standardApiName(input.apiName ?? nameFromLabel(label).replace(/_/g, ""))
    : customApiName(input.apiName ?? nameFromLabel(label));

  if (await findObject(ctx, apiName)) {
    throw new MetadataError(
      "DUPLICATE_DEVELOPER_NAME",
      `An object named ${apiName} already exists.`,
      "apiName",
    );
  }

  let keyPrefix: string;
  if (standard) {
    if (!/^[0-9A-Za-z]{3}$/.test(standard.keyPrefix)) {
      throw new MetadataError(
        "INVALID_FIELD",
        "Key prefix must be 3 letters or digits.",
        "keyPrefix",
      );
    }
    keyPrefix = standard.keyPrefix;
  } else {
    const { count } = await ctx.tx
      .selectFrom("object_def")
      .select(sql<number>`count(*)::int`.as("count"))
      .where("is_custom", "=", true)
      .executeTakeFirstOrThrow();
    if (count >= LIMITS.customObjectsPerOrg) {
      throw new MetadataError(
        "LIMIT_EXCEEDED",
        `An org can have at most ${LIMITS.customObjectsPerOrg} custom objects.`,
      );
    }
    keyPrefix = await allocateKeyPrefix(ctx);
  }

  const nameInput = input.nameField ?? {};
  const name = nameFieldProps(nameInput);
  const nameLabel = checkLabel(nameInput.label ?? `${label} Name`.slice(0, 40), "nameField.label");

  try {
    const object = await ctx.tx
      .insertInto("object_def")
      .values({
        id: newId(KeyPrefix.ObjectDef),
        org_id: ctx.orgId,
        api_name: apiName,
        label,
        plural_label: pluralLabel,
        description,
        key_prefix: keyPrefix,
        is_custom: !standard,
        sharing_model: sharingModel,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await ctx.tx
      .insertInto("field_def")
      .values({
        id: newId(KeyPrefix.FieldDef),
        org_id: ctx.orgId,
        object_id: object.id,
        api_name: "Name",
        label: nameLabel,
        type: name.type,
        is_custom: false,
        is_name_field: true,
        required: true,
        props: JSON.stringify(name.props),
        reference_to: null,
        relationship_name: null,
        relationship_label: null,
        delete_constraint: null,
        description: null,
        help_text: null,
      })
      .execute();
    return object;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MetadataError(
        "DUPLICATE_DEVELOPER_NAME",
        `An object named ${apiName} or with key prefix ${keyPrefix} was just created by someone else. Try again.`,
        "apiName",
      );
    }
    throw err;
  }
}

export async function updateObject(
  ctx: Ctx,
  apiName: string,
  patch: UpdateObjectInput,
): Promise<ObjectRow> {
  const object = await getObject(ctx, apiName);
  if (object.storage === "platform") {
    throw new MetadataError(
      "NOT_SUPPORTED",
      `${object.api_name} is a built-in object and can't be changed.`,
    );
  }
  const unknown = Object.keys(patch).filter(
    (k) => !["apiName", "label", "pluralLabel", "description", "sharingModel"].includes(k),
  );
  if (unknown.length) {
    throw new MetadataError(
      "INVALID_FIELD",
      `Objects don't have ${unknown.map((k) => `"${k}"`).join(", ")}.`,
      unknown[0],
    );
  }

  const changes: Record<string, unknown> = {};
  if (patch.label !== undefined) changes.label = checkLabel(patch.label, "label");
  if (patch.pluralLabel !== undefined)
    changes.plural_label = checkLabel(patch.pluralLabel, "pluralLabel");
  if (patch.description !== undefined) changes.description = checkDescription(patch.description);
  if (patch.sharingModel !== undefined) {
    const model = checkSharing(patch.sharingModel);
    if (object.sharing_model === "ControlledByParent") {
      throw new MetadataError(
        "FIELD_INTEGRITY_EXCEPTION",
        `${object.api_name} is controlled by its master-detail parent. Delete the master-detail field to set its own sharing.`,
        "sharingModel",
      );
    }
    changes.sharing_model = model;
  }
  if (patch.apiName !== undefined) {
    if (!object.is_custom) {
      throw new MetadataError("NOT_SUPPORTED", "Standard objects can't be renamed.", "apiName");
    }
    const renamed = customApiName(patch.apiName);
    const clash = await findObject(ctx, renamed);
    if (clash && clash.id !== object.id) {
      throw new MetadataError(
        "DUPLICATE_DEVELOPER_NAME",
        `An object named ${renamed} already exists.`,
        "apiName",
      );
    }
    changes.api_name = renamed;
  }
  if (Object.keys(changes).length === 0) return object;

  try {
    return await ctx.tx
      .updateTable("object_def")
      .set({ ...changes, updated_at: sql`now()` })
      .where("id", "=", object.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MetadataError(
        "DUPLICATE_DEVELOPER_NAME",
        "That API name was just taken. Try another.",
        "apiName",
      );
    }
    throw err;
  }
}

/**
 * Deletes a custom object with its fields, picklists and record types.
 * Refused while relationship fields on other objects point to it.
 */
export async function deleteObject(ctx: Ctx, apiName: string): Promise<void> {
  const object = await getObject(ctx, apiName);
  if (!object.is_custom) {
    throw new MetadataError(
      "CANNOT_DELETE",
      `${object.api_name} is a standard object and can't be deleted.`,
    );
  }
  const referencing = await ctx.tx
    .selectFrom("field_def as f")
    .innerJoin("object_def as o", "o.id", "f.object_id")
    .select(["o.api_name as object", "f.api_name as field"])
    .where("f.reference_to", "=", object.id)
    .where("f.object_id", "<>", object.id)
    .orderBy("o.api_name")
    .execute();
  if (referencing.length) {
    const list = referencing.map((r) => `${r.object}.${r.field}`).join(", ");
    throw new MetadataError(
      "CANNOT_DELETE",
      `Delete the fields that point to ${object.api_name} first: ${list}.`,
    );
  }
  try {
    await ctx.tx.deleteFrom("object_def").where("id", "=", object.id).execute();
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new MetadataError(
        "CANNOT_DELETE",
        `Another field started pointing to ${object.api_name}. Try again.`,
      );
    }
    throw err;
  }
}
