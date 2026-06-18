import { describe, expect, it } from "vitest";
import { normalizeServerUrl } from "../../../src/utilities/server-url";

describe("normalizeServerUrl", () => {
  it("strips a single trailing slash", () => {
    expect(normalizeServerUrl("https://r.example.test/")).toBe("https://r.example.test");
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeServerUrl("https://r.example.test///")).toBe("https://r.example.test");
  });

  it("leaves a clean URL unchanged and tolerates empty", () => {
    expect(normalizeServerUrl("https://r.example.test")).toBe("https://r.example.test");
    expect(normalizeServerUrl("")).toBe("");
  });
});
