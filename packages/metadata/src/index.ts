/**
 * The metadata engine: objects, fields, picklists and record types defined as
 * data (DECISIONS.md D-004, D-023 to D-028). Every function takes a context
 * whose transaction is already scoped to one org with withOrg().
 */
export { MetadataError, type MetadataErrorCode } from "./errors.js";
export { FIELD_TYPES, type FieldType, type PicklistValueInput } from "./field-types.js";
export { LIMITS } from "./limits.js";
export type { Ctx, FieldRow, ObjectMeta, ObjectRow, RecordTypeRow } from "./model.js";
export { loadObjectMeta } from "./model.js";
export {
  type CreateObjectInput,
  type NameFieldInput,
  type UpdateObjectInput,
  createObject,
  deleteObject,
  updateObject,
} from "./objects.js";
export {
  type FieldInput,
  type FieldPatch,
  createField,
  deleteField,
  updateField,
} from "./fields.js";
export {
  type PicklistValuePatch,
  addPicklistValues,
  deletePicklistValue,
  reorderPicklistValues,
  updatePicklistValue,
} from "./picklists.js";
export {
  type RecordTypeInput,
  type RecordTypePatch,
  type RecordTypePicklist,
  createRecordType,
  deleteRecordType,
  updateRecordType,
} from "./record-types.js";
export {
  type FieldDescribe,
  type GlobalDescribeEntry,
  MASTER_RECORD_TYPE_ID,
  type ObjectDescribe,
  buildDescribe,
  describeGlobal,
  describeObject,
  picklistValuesForRecordType,
} from "./describe.js";
