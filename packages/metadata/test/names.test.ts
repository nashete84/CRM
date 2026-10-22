import { describe, expect, it } from "vitest";
import { MetadataError } from "../src/errors.js";
import { checkAutoNumberFormat } from "../src/field-types.js";
import {
  childRelationshipName,
  customApiName,
  nameFromLabel,
  parentRelationshipName,
  standardApiName,
} from "../src/names.js";

describe("API names", () => {
  it("adds __c to custom names and accepts it already present", () => {
    expect(customApiName("Invoice")).toBe("Invoice__c");
    expect(customApiName("Invoice__c")).toBe("Invoice__c");
    expect(customApiName("Invoice__C")).toBe("Invoice__c");
    expect(customApiName("X")).toBe("X__c");
    expect(customApiName("Line_Item")).toBe("Line_Item__c");
  });

  it.each([
    ["", "empty"],
    ["1Invoice", "starts with a digit"],
    ["_Invoice", "starts with an underscore"],
    ["Invoice_", "ends with an underscore"],
    ["Line__Item", "double underscore"],
    ["Line Item", "space"],
    ["Línea", "non-ASCII letter"],
    ["A".repeat(41), "longer than 40"],
  ])("rejects %j (%s)", (name) => {
    expect(() => customApiName(name)).toThrow(MetadataError);
  });

  it("accepts exactly 40 characters before the suffix", () => {
    expect(customApiName("A".repeat(40))).toBe(`${"A".repeat(40)}__c`);
  });

  it("keeps standard names free of underscores", () => {
    expect(standardApiName("AccountId")).toBe("AccountId");
    expect(() => standardApiName("Account_Id")).toThrow(MetadataError);
  });

  it("derives a base name from a label", () => {
    expect(nameFromLabel("Invoice Line")).toBe("Invoice_Line");
    expect(nameFromLabel("  % Complete (est.)  ")).toBe("Complete_est");
    expect(nameFromLabel("2024 Target")).toBe("Target");
    expect(nameFromLabel("Año fiscal")).toBe("Ano_fiscal");
  });

  it("names relationships the Salesforce way", () => {
    expect(parentRelationshipName("Account__c", true)).toBe("Account__r");
    expect(parentRelationshipName("AccountId", false)).toBe("Account");
    expect(childRelationshipName("Invoices", true)).toBe("Invoices__r");
    expect(childRelationshipName("Contacts", false)).toBe("Contacts");
  });
});

describe("auto number display formats", () => {
  it.each(["INV-{0000}", "{0}", "CASE-{YYYY}{MM}{DD}-{000000}", "{YY}/{0000000000}"])(
    "accepts %j",
    (f) => {
      expect(() => checkAutoNumberFormat(f)).not.toThrow();
    },
  );

  it.each([
    ["INV-", "no number"],
    ["{0000}-{00}", "two numbers"],
    ["{00000000000}", "11 digits"],
    ["{0000}-{HH}", "unknown token"],
    ["INV-{0000", "unclosed brace"],
    ["INV-}{0000}", "stray brace"],
    [`${"X".repeat(25)}{0000}`, "longer than 30"],
  ])("rejects %j (%s)", (f) => {
    expect(() => checkAutoNumberFormat(f)).toThrow(MetadataError);
  });
});
