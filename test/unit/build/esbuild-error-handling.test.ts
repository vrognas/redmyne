import { describe, it, expect } from "vitest";

interface BuildError {
  text: string;
  location: { file: string; line: number; column: number } | null;
}

function formatError(error: BuildError): string {
  if (error.location) {
    return `${error.location.file}:${error.location.line}:${error.location.column}: ${error.text}`;
  }
  return error.text;
}

describe("esbuild error handling", () => {
  it("should handle error with location", () => {
    const error: BuildError = {
      text: "Error",
      location: { file: "a.ts", line: 1, column: 5 },
    };
    expect(formatError(error)).toBe("a.ts:1:5: Error");
  });

  it("should handle error without location", () => {
    const error: BuildError = {
      text: "Error",
      location: null,
    };
    expect(formatError(error)).toBe("Error");
  });
});
