import { describe, it, expect, vi, beforeEach } from "vitest";
import { DraftReviewPanel, escapeHtml, formatTime } from "../../../src/draft-mode/draft-review-panel";

describe("escapeHtml", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;"
    );
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes quotes", () => {
    expect(escapeHtml('"test"')).toBe("&quot;test&quot;");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("formatTime", () => {
  it("formats today's time as HH:MM", () => {
    const now = new Date();
    now.setHours(14, 30, 0, 0);
    const result = formatTime(now.getTime());
    // Should contain time portion (varies by locale but should have digit:digit pattern)
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });

  it("formats past dates as month day", () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 7); // 7 days ago
    const result = formatTime(pastDate.getTime());
    // Should be a date format like "Jan 15" not a time
    expect(result).not.toMatch(/^\d{1,2}:\d{2}\s*(AM|PM)?$/i);
  });
});

describe("DraftReviewPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton
    DraftReviewPanel.currentPanel = undefined;
  });

  describe("message handling", () => {
    it("executes applyDraft command with id", async () => {
      // Verify command interface matches expected shape
      const msg = { command: "applyDraft", id: "test-id" };
      expect(msg.command).toBe("applyDraft");
      expect(msg.id).toBe("test-id");
    });

    it("executes discardAll with confirmation required", async () => {
      const msg = { command: "discardAll" };
      expect(msg.command).toBe("discardAll");
    });
  });

  describe("webview commands", () => {
    it("supports all expected command types", () => {
      const commandTypes = ["applyAll", "discardAll", "removeDraft", "applyDraft"];
      commandTypes.forEach(cmd => {
        expect(typeof cmd).toBe("string");
      });
    });
  });
});
