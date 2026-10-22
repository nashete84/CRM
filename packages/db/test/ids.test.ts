import { describe, expect, it } from "vitest";
import { KeyPrefix, isValidId, newId, normalizeId, to18 } from "../src/ids.js";

describe("record ids", () => {
  it("encodes which characters are uppercase in the 3-character suffix", () => {
    // No uppercase letters: every chunk's bit mask is 0, which is "A".
    expect(to18("001000000000000")).toBe("001000000000000AAA");
    // Chunk 1 all uppercase (mask 31 -> "5"); chunk 2 only its first letter (1 -> "B").
    expect(to18("ABCDEA0000xyzab")).toBe("ABCDEA0000xyzab5BA");
    // Chunk 3, only the last character uppercase (mask 16 -> "Q").
    expect(to18("0000000000abcdZ")).toBe("0000000000abcdZAAQ");
  });

  it("gives IDs that differ only in letter case different suffixes", () => {
    expect(to18("001aaaaaaaaaaaa")).not.toBe(to18("001AAAAAAAAAAAA"));
  });

  it("generates valid IDs with the requested key prefix", () => {
    for (let i = 0; i < 200; i++) {
      const id = newId(KeyPrefix.User);
      expect(id).toHaveLength(18);
      expect(isValidId(id, KeyPrefix.User)).toBe(true);
    }
  });

  it("rejects a tampered suffix, the wrong prefix and malformed input", () => {
    const id = newId(KeyPrefix.Org);
    const tampered = id.slice(0, 15) + (id.endsWith("A") ? "B" : "A") + id.slice(16);
    expect(isValidId(tampered)).toBe(false);
    expect(isValidId(id, KeyPrefix.User)).toBe(false);
    expect(isValidId("00D' OR 1=1 --xxx")).toBe(false);
    expect(() => newId("toolong")).toThrow();
  });

  it("normalizes 15-character IDs and lower-case suffixes to the canonical form", () => {
    const id = newId(KeyPrefix.Org);
    expect(normalizeId(id.slice(0, 15))).toBe(id);
    expect(normalizeId(id.slice(0, 15) + id.slice(15).toLowerCase())).toBe(id);
    expect(normalizeId("short")).toBeNull();
  });
});
