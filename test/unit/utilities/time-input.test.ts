import { describe, it, expect } from "vitest";
import { parseTimeInput, validateTimeInput } from "../../../src/utilities/time-input";

describe("parseTimeInput", () => {
  it("parses decimal hours", () => {
    expect(parseTimeInput("1.75")).toBe(1.75);
    expect(parseTimeInput("2.5")).toBe(2.5);
  });

  it("parses comma decimal (European format)", () => {
    expect(parseTimeInput("1,75")).toBe(1.75);
  });

  it("parses colon format (hours:minutes)", () => {
    expect(parseTimeInput("1:30")).toBe(1.5);
    expect(parseTimeInput("2:45")).toBe(2.75);
  });

  it("parses unit format (1h 30min)", () => {
    expect(parseTimeInput("1h 30min")).toBe(1.5);
    expect(parseTimeInput("2h 45m")).toBe(2.75);
    expect(parseTimeInput("1hour")).toBe(1);
    expect(parseTimeInput("30min")).toBe(0.5);
  });

  it("returns null for invalid input", () => {
    expect(parseTimeInput("abc")).toBeNull();
    expect(parseTimeInput("1:60")).toBeNull(); // Invalid minutes
    expect(parseTimeInput("")).toBeNull();
  });
});

describe("validateTimeInput", () => {
  it("returns null for valid input", () => {
    expect(validateTimeInput("1.5")).toBeNull();
    expect(validateTimeInput("2:30")).toBeNull();
  });

  it("returns error for too small value", () => {
    expect(validateTimeInput("0.05")).toContain("Must be");
  });

  it("returns error for too large value", () => {
    expect(validateTimeInput("25")).toContain("Must be");
  });

  it("returns error when exceeding daily limit", () => {
    expect(validateTimeInput("5", 20)).toContain("exceed");
  });

  it("allows entry within daily limit", () => {
    expect(validateTimeInput("4", 20)).toBeNull();
  });
});
