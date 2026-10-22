import { normalizeId } from "@crm/db";
import {
  canonicalDecimal,
  formatDecimal,
  integerDigits,
  parseDecimal,
  roundTo,
} from "./decimal.js";
import type { FieldRow, PicklistRow } from "./model.js";

/**
 * Field values, per type: what callers may send, how it's stored, how it's
 * indexed and how it's returned. Stored values are JSON strings except
 * Checkbox (boolean); empty values are never stored (DECISIONS.md D-030).
 */
export type StoredValue = string | boolean;

/** Salesforce status codes for a value that can't be saved. */
export type ValueErrorCode =
  | "STRING_TOO_LONG"
  | "INVALID_EMAIL_ADDRESS"
  | "NUMBER_OUTSIDE_VALID_RANGE"
  | "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST"
  | "MALFORMED_ID"
  | "INVALID_TYPE_ON_FIELD_IN_RECORD";

export class ValueError extends Error {
  constructor(
    readonly code: ValueErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ValueError";
  }
}

export type ValueContext = {
  /** All picklist values of the field, in order (active and inactive). */
  picklist?: PicklistRow[] | undefined;
  /** The value already stored, which may stay even if no longer allowed (an inactive picklist value). */
  current?: StoredValue | null | undefined;
  /** Key prefix the referenced object's IDs start with (Lookup and MasterDetail). */
  targetKeyPrefix?: string | undefined;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;
// Salesforce's supported date range.
const MIN_YEAR = 1700;
const MAX_YEAR = 4000;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

function asText(field: FieldRow, v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new ValueError("INVALID_TYPE_ON_FIELD_IN_RECORD", `${field.label}: expected text.`);
}

function checkLength(field: FieldRow, s: string, max: number): string {
  if (s.length > max) {
    throw new ValueError(
      "STRING_TOO_LONG",
      `${field.label}: data value too large (max length=${max}).`,
    );
  }
  return s;
}

function validDate(y: number, m: number, d: number): boolean {
  if (y < MIN_YEAR || y > MAX_YEAR || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function picklistMatch(field: FieldRow, raw: string, ctx: ValueContext): string {
  const value = raw.trim();
  const list = ctx.picklist ?? [];
  const hit = list.find((p) => p.value.toLowerCase() === value.toLowerCase());
  const restricted = (field.props as { restricted?: boolean }).restricted === true;
  const current = typeof ctx.current === "string" ? ctx.current.split(";") : [];
  if (hit && (hit.is_active || current.includes(hit.value))) return hit.value;
  if (restricted) {
    throw new ValueError(
      "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST",
      `${field.label}: bad value for restricted picklist field: ${value}`,
    );
  }
  return checkLength(field, value, 255);
}

/**
 * Validates and normalises one value for storage. Returns null for "no value".
 * Checkbox never returns null: an empty checkbox is false.
 */
export function toStored(
  field: FieldRow,
  input: unknown,
  ctx: ValueContext = {},
): StoredValue | null {
  const props = field.props as Record<string, unknown>;
  if (field.type === "Checkbox") {
    if (isEmpty(input)) return false;
    if (typeof input === "boolean") return input;
    if (input === "true" || input === "false") return input === "true";
    throw new ValueError(
      "INVALID_TYPE_ON_FIELD_IN_RECORD",
      `${field.label}: expected true or false.`,
    );
  }
  if (isEmpty(input)) return null;

  switch (field.type) {
    case "Text":
      return checkLength(field, asText(field, input), Number(props.length ?? 255));
    case "TextArea":
      return checkLength(field, asText(field, input), 255);
    case "LongTextArea":
      return checkLength(field, asText(field, input), Number(props.length));
    case "Phone":
      return checkLength(field, asText(field, input), 40);
    case "Url":
      return checkLength(field, asText(field, input).trim(), 255);
    case "Email": {
      const s = checkLength(field, asText(field, input).trim(), 80);
      if (!EMAIL_RE.test(s))
        throw new ValueError(
          "INVALID_EMAIL_ADDRESS",
          `${field.label}: invalid email address: ${s}`,
        );
      return s;
    }
    case "Number":
    case "Currency":
    case "Percent": {
      if (typeof input !== "string" && typeof input !== "number") {
        throw new ValueError(
          "INVALID_TYPE_ON_FIELD_IN_RECORD",
          `${field.label}: expected a number.`,
        );
      }
      const d = parseDecimal(input);
      if (!d)
        throw new ValueError(
          "INVALID_TYPE_ON_FIELD_IN_RECORD",
          `${field.label}: "${input}" isn't a number.`,
        );
      const precision = Number(props.precision);
      const scale = Number(props.scale);
      const rounded = roundTo(d, scale);
      if (integerDigits(rounded) > precision - scale) {
        throw new ValueError(
          "NUMBER_OUTSIDE_VALID_RANGE",
          `${field.label}: value outside of valid range (at most ${precision - scale} digits before the decimal point).`,
        );
      }
      return formatDecimal(rounded);
    }
    case "Date": {
      const s = asText(field, input);
      const m = DATE_RE.exec(s);
      if (!m || !validDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
        throw new ValueError(
          "INVALID_TYPE_ON_FIELD_IN_RECORD",
          `${field.label}: "${s}" isn't a valid date (YYYY-MM-DD, years ${MIN_YEAR}-${MAX_YEAR}).`,
        );
      }
      return s;
    }
    case "DateTime": {
      const s = asText(field, input);
      const m = DATETIME_RE.exec(s);
      // No offset means UTC, as in the Salesforce API.
      const withZone = m && !m[8] ? `${s}Z` : s;
      const t = m ? new Date(withZone) : null;
      if (
        !m ||
        !t ||
        Number.isNaN(t.getTime()) ||
        !validDate(Number(m[1]), Number(m[2]), Number(m[3]))
      ) {
        throw new ValueError(
          "INVALID_TYPE_ON_FIELD_IN_RECORD",
          `${field.label}: "${s}" isn't a valid date and time (ISO 8601).`,
        );
      }
      const year = t.getUTCFullYear();
      if (year < MIN_YEAR || year > MAX_YEAR) {
        throw new ValueError(
          "INVALID_TYPE_ON_FIELD_IN_RECORD",
          `${field.label}: years ${MIN_YEAR}-${MAX_YEAR} only.`,
        );
      }
      return t.toISOString();
    }
    case "Picklist":
      return picklistMatch(field, asText(field, input), ctx);
    case "MultiselectPicklist": {
      const parts = Array.isArray(input)
        ? input.map((x) => asText(field, x))
        : asText(field, input).split(";");
      const chosen = [
        ...new Set(
          parts
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p) => picklistMatch(field, p, ctx)),
        ),
      ];
      if (chosen.length === 0) return null;
      // Keep the picklist's own order, like Salesforce; unknown values (unrestricted) go last.
      const order = new Map((ctx.picklist ?? []).map((p, i) => [p.value, i]));
      chosen.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
      if (chosen.length > 100)
        throw new ValueError(
          "STRING_TOO_LONG",
          `${field.label}: at most 100 values can be selected.`,
        );
      return checkLength(field, chosen.join(";"), 4099);
    }
    case "Lookup":
    case "MasterDetail": {
      const id = typeof input === "string" ? normalizeId(input.trim()) : null;
      if (!id)
        throw new ValueError(
          "MALFORMED_ID",
          `${field.label}: id value of incorrect type: ${String(input)}`,
        );
      if (ctx.targetKeyPrefix && !id.startsWith(ctx.targetKeyPrefix)) {
        throw new ValueError(
          "MALFORMED_ID",
          `${field.label}: ${id} isn't the ID of the right kind of record.`,
        );
      }
      return id;
    }
    case "AutoNumber":
      return asText(field, input);
  }
}

/** The value as the Salesforce REST API returns it. */
export function toApi(field: FieldRow, stored: StoredValue | null | undefined): unknown {
  if (field.type === "Checkbox") return stored === true;
  if (stored === null || stored === undefined) return null;
  if (field.type === "Number" || field.type === "Currency" || field.type === "Percent")
    return Number(stored);
  if (field.type === "DateTime" && typeof stored === "string") return apiDateTime(stored);
  return stored;
}

/** Salesforce's REST date-time format: "2026-10-22T08:00:00.000+0000". */
export function apiDateTime(value: Date | string): string {
  const iso = typeof value === "string" ? value : value.toISOString();
  return iso.replace(/Z$/, "+0000");
}

/** Normalised key for record_index: equal values give equal keys. */
export function indexKey(field: FieldRow, stored: StoredValue): string {
  if (typeof stored === "boolean") return String(stored);
  switch (field.type) {
    case "Number":
    case "Currency":
    case "Percent": {
      const d = parseDecimal(stored);
      return d ? canonicalDecimal(d) : stored;
    }
    case "Text":
      return (field.props as { caseSensitive?: boolean }).caseSensitive === true
        ? stored
        : stored.toLowerCase();
    case "Email":
      return stored.toLowerCase();
    default:
      return stored;
  }
}

/** Whether a field's values are mirrored into record_index. */
export function isIndexed(field: FieldRow): boolean {
  return (
    field.is_unique ||
    field.is_external_id ||
    field.type === "Lookup" ||
    field.type === "MasterDetail"
  );
}

/** "INV-{YYYY}-{0000}" with 7 on 2026-10-22 -> "INV-2026-0007". Dates are in UTC. */
export function formatAutoNumber(format: string, n: number | bigint, now = new Date()): string {
  const yyyy = String(now.getUTCFullYear());
  return format
    .replace(/\{0+\}/, (m) => String(n).padStart(m.length - 2, "0"))
    .replace("{YYYY}", yyyy)
    .replace("{YY}", yyyy.slice(2))
    .replace("{MM}", String(now.getUTCMonth() + 1).padStart(2, "0"))
    .replace("{DD}", String(now.getUTCDate()).padStart(2, "0"));
}
