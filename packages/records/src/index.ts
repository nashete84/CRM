/**
 * Record storage: create, read, update, upsert, delete, undelete and purge
 * records of any object defined in @crm/metadata (DECISIONS.md D-029 to D-034).
 * Runs in system mode; permissions and sharing wrap it from step 5.
 */
export { API_VERSION, type RecordCtx } from "./context.js";
export { RecordError, type RecordErrorItem, type RecordStatusCode } from "./errors.js";
export { type RecordInput, createRecord, updateRecord, upsertRecord } from "./write.js";
export {
  type DeleteResult,
  type RecycleBinEntry,
  type UndeleteResult,
  deleteRecord,
  listRecycleBin,
  purgeDeleted,
  undeleteRecord,
} from "./delete.js";
export { type SObject, getRecord, getRecords, toSObject } from "./read.js";
