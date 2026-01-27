import { describe, it, expect } from "vitest";
import { parseIssueId } from "../../../src/utilities/validation";

describe("parseIssueId", () => {
  it("returns number for valid string", () => {
    expect(parseIssueId("123")).toBe(123);
    expect(parseIssueId("1")).toBe(1);
    expect(parseIssueId("999999")).toBe(999999);
  });

  it("returns null for empty/null/undefined", () => {
    expect(parseIssueId("")).toBeNull();
    expect(parseIssueId("   ")).toBeNull();
    expect(parseIssueId(null)).toBeNull();
    expect(parseIssueId(undefined)).toBeNull();
  });

  it("returns null for non-numeric prefix", () => {
    expect(parseIssueId("abc")).toBeNull();
    expect(parseIssueId("abc12")).toBeNull();
  });

  it("parses leading digits from mixed strings", () => {
    // parseInt behavior: extracts leading numeric part
    expect(parseIssueId("12abc")).toBe(12);
  });

  it("returns null for zero or negative", () => {
    expect(parseIssueId("0")).toBeNull();
    expect(parseIssueId("-1")).toBeNull();
    expect(parseIssueId("-100")).toBeNull();
  });
});
