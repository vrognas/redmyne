import { formatCustomFieldValue } from "../../../src/utilities/custom-field-formatter";

describe("formatCustomFieldValue", () => {
  it("returns empty string for null", () => {
    expect(formatCustomFieldValue(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(formatCustomFieldValue(undefined)).toBe("");
  });

  it("trims string values", () => {
    expect(formatCustomFieldValue("  test  ")).toBe("test");
  });

  it("returns string as-is when no trimming needed", () => {
    expect(formatCustomFieldValue("test")).toBe("test");
  });

  it("joins array of strings with comma", () => {
    expect(formatCustomFieldValue(["a", "b", "c"])).toBe("a, b, c");
  });

  it("filters empty strings from array", () => {
    expect(formatCustomFieldValue(["a", "", "b"])).toBe("a, b");
  });

  it("trims array values", () => {
    expect(formatCustomFieldValue(["  a  ", "b  "])).toBe("a, b");
  });

  it("converts numbers to string", () => {
    expect(formatCustomFieldValue(42)).toBe("42");
  });

  it("converts booleans to string", () => {
    expect(formatCustomFieldValue(true)).toBe("true");
    expect(formatCustomFieldValue(false)).toBe("false");
  });

  it("handles array with numbers", () => {
    expect(formatCustomFieldValue([1, 2, 3])).toBe("1, 2, 3");
  });

  it("handles mixed array types", () => {
    expect(formatCustomFieldValue(["a", 1, true])).toBe("a, 1, true");
  });

  it("returns empty string for objects", () => {
    expect(formatCustomFieldValue({ foo: "bar" })).toBe("");
  });

  it("filters objects from arrays", () => {
    expect(formatCustomFieldValue(["a", { foo: "bar" }, "b"])).toBe("a, b");
  });

  it("returns empty for empty array", () => {
    expect(formatCustomFieldValue([])).toBe("");
  });
});
