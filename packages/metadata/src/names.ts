import { MetadataError } from "./errors.js";

/**
 * Salesforce naming rules for API names: start with a letter; letters, digits
 * and single underscores only; no trailing underscore; at most 40 characters
 * before the __c suffix. API names are compared case-insensitively.
 */
const BASE_RE = /^[A-Za-z](?:[A-Za-z0-9]|_(?!_))*$/;
const MAX_BASE = 40;

/** System fields every record has; standard fields can't reuse these names. */
export const SYSTEM_FIELD_NAMES = new Set(
  [
    "Id",
    "OwnerId",
    "RecordTypeId",
    "IsDeleted",
    "CreatedDate",
    "CreatedById",
    "LastModifiedDate",
    "LastModifiedById",
    "SystemModstamp",
  ].map((w) => w.toLowerCase()),
);

function checkBase(base: string, what: string, path: string): void {
  if (base.length === 0 || base.length > MAX_BASE) {
    throw new MetadataError("INVALID_NAME", `${what} must be 1 to ${MAX_BASE} characters.`, path);
  }
  if (!BASE_RE.test(base) || base.endsWith("_")) {
    throw new MetadataError(
      "INVALID_NAME",
      `${what} "${base}" must start with a letter and use only letters, numbers and single underscores, not ending in an underscore.`,
      path,
    );
  }
}

/**
 * Accepts "Invoice" or "Invoice__c" for a custom component and returns the
 * canonical "Invoice__c".
 */
export function customApiName(input: string, what = "API name", path = "apiName"): string {
  const trimmed = input.trim();
  const base = trimmed.toLowerCase().endsWith("__c") ? trimmed.slice(0, -3) : trimmed;
  checkBase(base, what, path);
  return `${base}__c`;
}

/** Standard components (seeded by the platform) have no suffix. */
export function standardApiName(input: string, what = "API name", path = "apiName"): string {
  const name = input.trim();
  checkBase(name, what, path);
  if (name.includes("_")) {
    throw new MetadataError(
      "INVALID_NAME",
      `Standard ${what} "${name}" can't contain underscores.`,
      path,
    );
  }
  return name;
}

/** Child relationship names (Account.Contacts, Account.Invoices__r) are stored without __r. */
export function relationshipBaseName(input: string, path = "relationshipName"): string {
  const trimmed = input.trim();
  const base = trimmed.toLowerCase().endsWith("__r") ? trimmed.slice(0, -3) : trimmed;
  checkBase(base, "Relationship name", path);
  return base;
}

/** Turns a label into a default API base name: "Invoice Line" -> "Invoice_Line". */
export function nameFromLabel(label: string): string {
  const cleaned = label
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // drop accents: "Año" -> "Ano"
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/^[^A-Za-z]+/, "");
  return cleaned.slice(0, MAX_BASE).replace(/_+$/, "") || "Field";
}

export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The name a child uses to reach its parent: Contact.Account (standard field
 * AccountId) or Invoice__c.Account__r (custom field Account__c).
 */
export function parentRelationshipName(fieldApiName: string, isCustom: boolean): string {
  if (isCustom) return `${fieldApiName.slice(0, -3)}__r`;
  return fieldApiName.endsWith("Id") ? fieldApiName.slice(0, -2) : fieldApiName;
}

/** The name a parent uses to reach its children: Account.Contacts or Account.Invoices__r. */
export function childRelationshipName(base: string, isCustom: boolean): string {
  return isCustom ? `${base}__r` : base;
}

export function checkLabel(label: unknown, path: string, max = 40): string {
  if (typeof label !== "string" || label.trim().length === 0 || label.trim().length > max) {
    throw new MetadataError("INVALID_FIELD", `Label must be 1 to ${max} characters.`, path);
  }
  return label.trim();
}
