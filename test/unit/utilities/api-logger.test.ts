import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as vscode from "vscode";
import { ApiLogger } from "../../../src/utilities/api-logger";

describe("ApiLogger", () => {
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };
  let logger: ApiLogger;

  beforeEach(() => {
    mockChannel = { appendLine: vi.fn() };
    logger = new ApiLogger(mockChannel as unknown as vscode.OutputChannel);
  });

  it("logs successful request", () => {
    logger.logRequest(1, "GET", "/issues.json");
    logger.logResponse(1, 200, 142);

    expect(mockChannel.appendLine).toHaveBeenCalledTimes(2);
    expect(mockChannel.appendLine).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[1\] GET \/issues\.json/)
    );
    expect(mockChannel.appendLine).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[1\] → 200 \(142ms\)/)
    );
  });

  it("logs error request", () => {
    logger.logRequest(2, "PUT", "/issues/123.json");
    logger.logError(2, new Error("Network error"), 89);

    expect(mockChannel.appendLine).toHaveBeenCalledTimes(2);
    expect(mockChannel.appendLine).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[2\] PUT \/issues\/123\.json/)
    );
    expect(mockChannel.appendLine).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[2\] ERROR: Network error \(89ms\)/)
    );
  });

  it("redacts sensitive query params via shared SENSITIVE_FIELDS", () => {
    logger.logRequest(1, "GET", "/issues.json?token=abc123&apikey=xyz&project_id=5");

    const logged = mockChannel.appendLine.mock.calls[0][0] as string;
    expect(logged).toContain("token=***");
    expect(logged).toContain("apikey=***");
    expect(logged).not.toContain("abc123");
    expect(logged).not.toContain("xyz");
    expect(logged).toContain("project_id=5");
  });

  it("increments counter sequentially", () => {
    logger.logRequest(1, "GET", "/projects.json");
    logger.logResponse(1, 200, 50);
    logger.logRequest(2, "GET", "/issues.json");
    logger.logResponse(2, 200, 75);

    expect(mockChannel.appendLine).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("[1]")
    );
    expect(mockChannel.appendLine).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("[1]")
    );
    expect(mockChannel.appendLine).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("[2]")
    );
    expect(mockChannel.appendLine).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("[2]")
    );
  });
});
