import { describe, it, expect } from "vitest";
import { errorToString } from "../../../src/utilities/error-to-string";

describe("errorToString", () => {
  it("should convert Error to string", () => {
    const error = new Error("Test error");
    expect(errorToString(error)).toBe("Test error");
  });

  it("should convert string to string", () => {
    expect(errorToString("Simple error")).toBe("Simple error");
  });

  it("should convert object with message to string", () => {
    expect(errorToString({ message: "Object error" })).toBe("Object error");
  });

  it("should handle number as unknown error", () => {
    expect(errorToString(42)).toBe("Unknown error");
  });

  it("should handle boolean true as unknown error", () => {
    expect(errorToString(true)).toBe("Unknown error");
  });

  it("should handle boolean false as empty string", () => {
    expect(errorToString(false)).toBe("");
  });

  it("should convert object without message to keys string", () => {
    const result = errorToString({ code: 500, status: "error" });
    expect(result).toContain("Unknown error object");
    expect(result).toContain("keys:");
  });

  it("should handle null as empty string", () => {
    expect(errorToString(null)).toBe("");
  });

  it("should handle undefined as empty string", () => {
    expect(errorToString(undefined)).toBe("");
  });
});
