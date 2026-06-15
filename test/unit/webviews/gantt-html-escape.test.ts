import { describe, it, expect } from "vitest";
import { escapeHtml, escapeAttr } from "../../../src/webviews/gantt-html-escape";

describe("gantt-html-escape (canonical escaper)", () => {
  describe("escapeHtml", () => {
    it("escapes the full XSS-sensitive entity set", () => {
      expect(escapeHtml("<script>alert('xss')</script>")).toBe(
        "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"
      );
      expect(escapeHtml("a & b")).toBe("a &amp; b");
      expect(escapeHtml('"q"')).toBe("&quot;q&quot;");
    });

    it("also escapes backtick, dollar and backslash (template-literal safety)", () => {
      expect(escapeHtml("`${x}`")).toBe("&#96;&#36;{x}&#96;");
      expect(escapeHtml("a\\b")).toBe("a&#92;b");
    });

    it("tolerates null/undefined and empty string", () => {
      expect(escapeHtml(null)).toBe("");
      expect(escapeHtml(undefined)).toBe("");
      expect(escapeHtml("")).toBe("");
    });
  });

  describe("escapeAttr", () => {
    it("escapes like escapeHtml plus newlines", () => {
      expect(escapeAttr('a\n"b"')).toBe("a&#10;&quot;b&quot;");
    });
  });
});
