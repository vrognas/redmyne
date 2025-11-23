import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";

const HOOK_PATH = join(__dirname, "../../../scripts/commit-msg");
const TEST_MSG_FILE = join(__dirname, "test-commit-msg.txt");

describe("commit-msg hook", () => {
  afterEach(() => {
    try {
      unlinkSync(TEST_MSG_FILE);
    } catch {
      // ignore
    }
  });

  it("should pass for valid subject (50 chars)", () => {
    writeFileSync(TEST_MSG_FILE, "feat: add commit message validation hook now");
    const result = execSync(`${HOOK_PATH} ${TEST_MSG_FILE}`, {
      encoding: "utf8",
    });
    expect(result).toBe("");
  });

  it("should fail for subject > 50 chars", () => {
    writeFileSync(
      TEST_MSG_FILE,
      "feat: add commit message validation hook right now!",
    );
    expect(() => execSync(`${HOOK_PATH} ${TEST_MSG_FILE}`)).toThrow();
  });

  it("should pass for subject + blank line + body (72 chars)", () => {
    const msg = `feat: add hook

This is a body line that is exactly seventy-two characters in length.`;
    writeFileSync(TEST_MSG_FILE, msg);
    const result = execSync(`${HOOK_PATH} ${TEST_MSG_FILE}`, {
      encoding: "utf8",
    });
    expect(result).toBe("");
  });

  it("should fail for body line > 72 chars", () => {
    const msg = `feat: add hook

This is a body line that exceeds the maximum allowed length of seventy-two.`;
    writeFileSync(TEST_MSG_FILE, msg);
    expect(() => execSync(`${HOOK_PATH} ${TEST_MSG_FILE}`)).toThrow();
  });

  it("should fail if no blank line between subject and body", () => {
    const msg = `feat: add hook
Body without blank line`;
    writeFileSync(TEST_MSG_FILE, msg);
    expect(() => execSync(`${HOOK_PATH} ${TEST_MSG_FILE}`)).toThrow();
  });

  it("should allow merge commits", () => {
    const msg = `Merge pull request #123 from user/very-long-branch-name-that-exceeds-fifty-chars

Some body text`;
    writeFileSync(TEST_MSG_FILE, msg);
    const result = execSync(`${HOOK_PATH} ${TEST_MSG_FILE}`, {
      encoding: "utf8",
    });
    expect(result).toBe("");
  });

  it("should allow revert commits", () => {
    const msg = `Revert "some very long commit message that definitely exceeds the fifty character limit"

This reverts commit abc123.`;
    writeFileSync(TEST_MSG_FILE, msg);
    const result = execSync(`${HOOK_PATH} ${TEST_MSG_FILE}`, {
      encoding: "utf8",
    });
    expect(result).toBe("");
  });
});
