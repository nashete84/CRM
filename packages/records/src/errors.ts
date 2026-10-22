/**
 * Salesforce's per-record error shape: a list of { statusCode, message, fields },
 * so API clients written for Salesforce can read our errors unchanged.
 */
export type RecordStatusCode =
  | "REQUIRED_FIELD_MISSING"
  | "INVALID_FIELD"
  | "INVALID_FIELD_FOR_INSERT_UPDATE"
  | "INVALID_CROSS_REFERENCE_KEY"
  | "DUPLICATE_VALUE"
  | "DUPLICATE_EXTERNAL_ID"
  | "ENTITY_IS_DELETED"
  | "DELETE_FAILED"
  | "UNDELETE_FAILED"
  | "NOT_FOUND"
  | "INVALID_TYPE"
  | "INACTIVE_OWNER_OR_USER"
  | "INVALID_ID_FIELD"
  // Value errors from @crm/metadata
  | "STRING_TOO_LONG"
  | "INVALID_EMAIL_ADDRESS"
  | "NUMBER_OUTSIDE_VALID_RANGE"
  | "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST"
  | "MALFORMED_ID"
  | "INVALID_TYPE_ON_FIELD_IN_RECORD";

export type RecordErrorItem = { statusCode: RecordStatusCode; message: string; fields: string[] };

export class RecordError extends Error {
  readonly errors: RecordErrorItem[];

  constructor(errors: RecordErrorItem[]) {
    super(errors.map((e) => e.message).join(" "));
    this.name = "RecordError";
    this.errors = errors;
  }

  static of(statusCode: RecordStatusCode, message: string, fields: string[] = []): RecordError {
    return new RecordError([{ statusCode, message, fields }]);
  }

  /** The first status code, for callers that branch on one. */
  get statusCode(): RecordStatusCode {
    return this.errors[0]?.statusCode ?? "INVALID_FIELD";
  }
}
