import { describe, expect, it } from "vitest";
import { canonicalDecimal, formatDecimal, parseDecimal, roundTo } from "../src/decimal.js";
import type { FieldRow, PicklistRow } from "../src/model.js";
import { ValueError, formatAutoNumber, indexKey, toApi, toStored } from "../src/values.js";

function field(type: FieldRow["type"], props: Record<string, unknown> = {}): FieldRow {
  return {
    id: "00N000000000001AAA",
    org_id: "x",
    object_id: "x",
    api_name: "F__c",
    label: "Field",
    type,
    is_custom: true,
    is_name_field: false,
    required: false,
    is_unique: false,
    is_external_id: false,
    description: null,
    help_text: null,
    props,
    reference_to: null,
    relationship_name: null,
    relationship_label: null,
    delete_constraint: null,
    seq: "1",
    created_at: new Date(),
    updated_at: new Date(),
  };
}

const pick = (value: string, active = true, order = 0): PicklistRow => ({
  org_id: "x",
  field_id: "f",
  value,
  label: value,
  sort_order: order,
  is_default: false,
  is_active: active,
});

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValueError) return e.code;
    throw e;
  }
  return undefined;
}

describe("exact decimals", () => {
  it("parses without binary rounding", () => {
    const d = parseDecimal("123456789012345678.99");
    expect(d && formatDecimal(d)).toBe("123456789012345678.99");
    expect(parseDecimal("1e3") && formatDecimal(parseDecimal("1e3") as never)).toBe("1000");
    expect(parseDecimal(".5") && formatDecimal(parseDecimal(".5") as never)).toBe("0.5");
    for (const bad of ["", "abc", "1.2.3", "--1", "1e", "0x10", "Infinity"])
      expect(parseDecimal(bad), bad).toBeNull();
  });

  it("rounds half away from zero", () => {
    const r = (s: string, scale: number) => formatDecimal(roundTo(parseDecimal(s) as never, scale));
    expect(r("2.345", 2)).toBe("2.35");
    expect(r("-2.345", 2)).toBe("-2.35");
    expect(r("2.344", 2)).toBe("2.34");
    expect(r("0.004", 2)).toBe("0.00");
    expect(r("-0.004", 2)).toBe("0.00");
    expect(r("7", 2)).toBe("7.00");
  });

  it("compares canonically", () => {
    expect(canonicalDecimal(parseDecimal("1.50") as never)).toBe("1.5");
    expect(canonicalDecimal(parseDecimal("-0.0") as never)).toBe("0");
    expect(canonicalDecimal(parseDecimal("100") as never)).toBe("100");
  });
});

describe("field values", () => {
  it("stores currency exactly, rounded to its scale, within its precision", () => {
    const f = field("Currency", { precision: 18, scale: 2 });
    expect(toStored(f, "1234567890123456.789")).toBe("1234567890123456.79");
    expect(toStored(f, 0.1 + 0.2)).toBe("0.30");
    expect(toApi(f, "12.50")).toBe(12.5);
    expect(code(() => toStored(f, "12345678901234567"))).toBe("NUMBER_OUTSIDE_VALID_RANGE");
    expect(code(() => toStored(f, "twelve"))).toBe("INVALID_TYPE_ON_FIELD_IN_RECORD");
    expect(code(() => toStored(f, true))).toBe("INVALID_TYPE_ON_FIELD_IN_RECORD");
    expect(indexKey(f, "12.50")).toBe(indexKey(f, "12.5"));
  });

  it("checks text lengths and emails", () => {
    expect(code(() => toStored(field("Text", { length: 5 }), "123456"))).toBe("STRING_TOO_LONG");
    expect(toStored(field("Text", { length: 5 }), 12345)).toBe("12345");
    expect(code(() => toStored(field("TextArea"), "x".repeat(256)))).toBe("STRING_TOO_LONG");
    expect(toStored(field("Email"), " ana@acme.test ")).toBe("ana@acme.test");
    expect(code(() => toStored(field("Email"), "ana@acme"))).toBe("INVALID_EMAIL_ADDRESS");
  });

  it("treats empty as no value, except a checkbox which is false", () => {
    expect(toStored(field("Text", { length: 10 }), "")).toBeNull();
    expect(toStored(field("Date"), null)).toBeNull();
    expect(toStored(field("Checkbox"), null)).toBe(false);
    expect(toStored(field("Checkbox"), "true")).toBe(true);
    expect(code(() => toStored(field("Checkbox"), "yes"))).toBe("INVALID_TYPE_ON_FIELD_IN_RECORD");
    expect(toApi(field("Checkbox"), undefined)).toBe(false);
  });

  it("accepts real dates only, in Salesforce's range", () => {
    expect(toStored(field("Date"), "2024-02-29")).toBe("2024-02-29");
    for (const bad of [
      "2023-02-29",
      "2024-13-01",
      "1699-12-31",
      "4001-01-01",
      "22/10/2026",
      "2026-10-22T00:00:00Z",
    ]) {
      expect(
        code(() => toStored(field("Date"), bad)),
        bad,
      ).toBe("INVALID_TYPE_ON_FIELD_IN_RECORD");
    }
  });

  it("normalises date-times to UTC, treating no offset as UTC", () => {
    expect(toStored(field("DateTime"), "2026-10-22T10:00:00+02:00")).toBe(
      "2026-10-22T08:00:00.000Z",
    );
    expect(toStored(field("DateTime"), "2026-10-22T08:00")).toBe("2026-10-22T08:00:00.000Z");
    expect(code(() => toStored(field("DateTime"), "2026-10-22"))).toBe(
      "INVALID_TYPE_ON_FIELD_IN_RECORD",
    );
    expect(code(() => toStored(field("DateTime"), "2026-02-30T00:00:00Z"))).toBe(
      "INVALID_TYPE_ON_FIELD_IN_RECORD",
    );
  });

  it("matches picklist values case-insensitively and keeps inactive ones only if already set", () => {
    const f = field("Picklist", { restricted: true });
    const list = [pick("Open"), pick("Closed"), pick("Legacy", false)];
    expect(toStored(f, "open", { picklist: list })).toBe("Open");
    expect(code(() => toStored(f, "Pending", { picklist: list }))).toBe(
      "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST",
    );
    expect(code(() => toStored(f, "Legacy", { picklist: list }))).toBe(
      "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST",
    );
    expect(toStored(f, "Legacy", { picklist: list, current: "Legacy" })).toBe("Legacy");
    expect(toStored(field("Picklist", { restricted: false }), "Pending", { picklist: list })).toBe(
      "Pending",
    );
  });

  it("stores multi-select values once each, in picklist order", () => {
    const f = field("MultiselectPicklist", { restricted: true });
    const list = [pick("Red", true, 0), pick("Green", true, 1), pick("Blue", true, 2)];
    expect(toStored(f, "blue;Red;red", { picklist: list })).toBe("Red;Blue");
    expect(toStored(f, ["Green", "Red"], { picklist: list })).toBe("Red;Green");
    expect(toStored(f, " ; ", { picklist: list })).toBeNull();
  });

  it("accepts 15- and 18-character IDs of the right object", () => {
    const f = field("Lookup");
    expect(toStored(f, "001000000000001", { targetKeyPrefix: "001" })).toBe("001000000000001AAA");
    expect(code(() => toStored(f, "003000000000001", { targetKeyPrefix: "001" }))).toBe(
      "MALFORMED_ID",
    );
    expect(code(() => toStored(f, "not-an-id"))).toBe("MALFORMED_ID");
  });

  it("folds case in index keys only where the field is case-insensitive", () => {
    expect(indexKey(field("Text"), "ABC")).toBe("abc");
    expect(indexKey(field("Text", { caseSensitive: true }), "ABC")).toBe("ABC");
    expect(indexKey(field("Email"), "Ana@Acme.TEST")).toBe("ana@acme.test");
  });

  it("formats auto numbers", () => {
    const d = new Date("2026-10-22T23:30:00Z");
    expect(formatAutoNumber("INV-{YYYY}-{0000}", 7, d)).toBe("INV-2026-0007");
    expect(formatAutoNumber("{YY}{MM}{DD}/{00}", 123, d)).toBe("261022/123");
  });
});
