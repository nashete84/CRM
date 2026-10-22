import { normalizeId } from "@crm/db";
import { type ObjectMeta, type StoredValue, apiDateTime, toApi } from "@crm/metadata";
import { API_VERSION, type RecordCtx, loadMeta } from "./context.js";
import { RecordError } from "./errors.js";
import type { RecordRow } from "./write.js";

/** A record in Salesforce REST shape: attributes, system fields, then fields by API name. */
export type SObject = { attributes: { type: string; url: string } } & Record<string, unknown>;

export function toSObject(meta: ObjectMeta, row: RecordRow): SObject {
  const type = meta.object.api_name;
  const out: SObject = {
    attributes: { type, url: `/services/data/${API_VERSION}/sobjects/${type}/${row.id}` },
    Id: row.id,
    IsDeleted: row.is_deleted,
  };
  const data = row.data as Record<string, StoredValue>;
  for (const f of meta.fields) {
    out[f.api_name] = f.is_name_field ? row.name : toApi(f, data[f.id]);
  }
  if (meta.object.sharing_model !== "ControlledByParent") out.OwnerId = row.owner_id;
  if (meta.recordTypes.length > 0) out.RecordTypeId = row.record_type_id;
  out.CreatedDate = apiDateTime(row.created_at);
  out.CreatedById = row.created_by_id;
  out.LastModifiedDate = apiDateTime(row.last_modified_at);
  out.LastModifiedById = row.last_modified_by_id;
  out.SystemModstamp = apiDateTime(row.system_modstamp);
  return out;
}

/** One record by ID, or null if it doesn't exist. Records in the recycle bin only when asked. */
export async function getRecord(
  ctx: RecordCtx,
  objectApiName: string,
  id: string,
  { includeDeleted = false }: { includeDeleted?: boolean } = {},
): Promise<SObject | null> {
  const meta = await loadMeta(ctx, objectApiName);
  const canonical = normalizeId(String(id).trim());
  if (!canonical || !canonical.startsWith(meta.object.key_prefix)) {
    throw RecordError.of("MALFORMED_ID", `Invalid ${meta.object.api_name} id: ${String(id)}`);
  }
  let q = ctx.tx
    .selectFrom("record")
    .selectAll()
    .where("id", "=", canonical)
    .where("object_id", "=", meta.object.id);
  if (!includeDeleted) q = q.where("is_deleted", "=", false);
  const row = await q.executeTakeFirst();
  return row ? toSObject(meta, row) : null;
}

/** Several records of one object, in the order asked; missing IDs are skipped. */
export async function getRecords(
  ctx: RecordCtx,
  objectApiName: string,
  ids: string[],
): Promise<SObject[]> {
  const meta = await loadMeta(ctx, objectApiName);
  const canonical = ids
    .map((i) => normalizeId(String(i).trim()))
    .filter((x): x is string => x !== null);
  if (canonical.length === 0) return [];
  const rows = await ctx.tx
    .selectFrom("record")
    .selectAll()
    .where("id", "in", canonical)
    .where("object_id", "=", meta.object.id)
    .where("is_deleted", "=", false)
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return canonical
    .map((i) => byId.get(i))
    .filter((r): r is RecordRow => r !== undefined)
    .map((r) => toSObject(meta, r));
}
