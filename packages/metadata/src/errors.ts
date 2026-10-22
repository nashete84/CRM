/** Salesforce-style error codes, so API clients can branch on familiar values. */
export type MetadataErrorCode =
  | "INVALID_NAME" // API name breaks the naming rules
  | "INVALID_FIELD" // a property is missing, of the wrong type, or out of range
  | "DUPLICATE_DEVELOPER_NAME" // API name, relationship name or picklist value already used
  | "NOT_FOUND"
  | "LIMIT_EXCEEDED"
  | "FIELD_INTEGRITY_EXCEPTION" // relationship and sharing rules
  | "CANNOT_DELETE"
  | "INVALID_TYPE_CHANGE"
  | "NOT_SUPPORTED";

export class MetadataError extends Error {
  readonly code: MetadataErrorCode;
  /** Which input property the error is about, when there is one ("length", "values[2]"). */
  readonly path: string | undefined;

  constructor(code: MetadataErrorCode, message: string, path?: string) {
    super(message);
    this.name = "MetadataError";
    this.code = code;
    this.path = path;
  }
}

/** Postgres unique violation, e.g. two admins creating the same field at once. */
export function isUniqueViolation(err: unknown): err is { code: string; constraint?: string } {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23503";
}
