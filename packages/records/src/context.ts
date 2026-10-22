import type { Tx } from "@crm/db";
import { type FieldRow, MetadataError, type ObjectMeta, loadObjectMeta } from "@crm/metadata";
import { RecordError } from "./errors.js";

/**
 * A transaction scoped to one org with withOrg(), plus who is acting. This
 * layer runs in "system mode": it checks data rules, not permissions. Sharing
 * and field-level security wrap it in step 5 (DECISIONS.md D-029).
 */
export type RecordCtx = { tx: Tx; orgId: string; userId: string };

/** Salesforce REST API version used in record URLs (settled in step 8). */
export const API_VERSION = "v62.0";

export async function loadMeta(ctx: RecordCtx, objectApiName: string): Promise<ObjectMeta> {
  let meta: ObjectMeta;
  try {
    meta = await loadObjectMeta(ctx, objectApiName);
  } catch (err) {
    if (err instanceof MetadataError && err.code === "NOT_FOUND") {
      throw RecordError.of("INVALID_TYPE", `sObject type '${objectApiName}' is not supported.`);
    }
    throw err;
  }
  if (meta.object.storage === "platform") {
    throw RecordError.of(
      "INVALID_TYPE",
      `${meta.object.api_name} records are managed by the platform, not through the records API.`,
    );
  }
  return meta;
}

/** Field lookup by API name, ignoring case like Salesforce. */
export function fieldMap(meta: ObjectMeta): Map<string, FieldRow> {
  return new Map(meta.fields.map((f) => [f.api_name.toLowerCase(), f]));
}

/** The org's Name field (Text or AutoNumber). Every record-storage object has one. */
export function nameField(meta: ObjectMeta): FieldRow {
  const f = meta.fields.find((x) => x.is_name_field);
  if (!f) throw new Error(`${meta.object.api_name} has no Name field`);
  return f;
}
