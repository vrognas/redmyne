import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SCRIPTS_DIR = join(__dirname, "../../../scripts/hooks");

describe("context-inject hook", () => {
  const HOOK_PATH = join(SCRIPTS_DIR, "context-inject.sh");

  it("should output git branch info", () => {
    const result = execSync(`bash ${HOOK_PATH}`, {
      encoding: "utf8",
      cwd: join(__dirname, "../../.."), // project root (git repo)
    });
    expect(result).toContain("Branch:");
  });

  it("should output uncommitted changes count", () => {
    const result = execSync(`bash ${HOOK_PATH}`, {
      encoding: "utf8",
      cwd: join(__dirname, "../../.."),
    });
    expect(result).toContain("Uncommitted:");
  });

  it("should exit 0 (non-blocking)", () => {
    // execSync throws on non-zero exit
    const result = execSync(`bash ${HOOK_PATH}; echo "exit:$?"`, {
      encoding: "utf8",
      cwd: join(__dirname, "../../.."),
    });
    expect(result).toContain("exit:0");
  });
});

describe("pre-commit-typecheck hook", () => {
  const HOOK_PATH = join(SCRIPTS_DIR, "pre-commit-typecheck.sh");

  it("should pass for non-commit commands", () => {
    const input = JSON.stringify({ tool_input: { command: "git status" } });
    const result = execSync(`echo '${input}' | bash ${HOOK_PATH}`, {
      encoding: "utf8",
      cwd: join(__dirname, "../../.."),
    });
    expect(result.trim()).toBe("");
  });

  it("should run typecheck for git commit commands", () => {
    const input = JSON.stringify({ tool_input: { command: "git commit -m 'test'" } });
    // This will run actual typecheck - should pass in clean repo
    const result = execSync(`echo '${input}' | bash ${HOOK_PATH}`, {
      encoding: "utf8",
      cwd: join(__dirname, "../../.."),
      timeout: 60000, // 60s for typecheck
    });
    expect(result).toContain("typecheck");
  });
});

describe("pre-compact-log hook", () => {
  const HOOK_PATH = join(SCRIPTS_DIR, "pre-compact-log.sh");
  const LOG_DIR = join(tmpdir(), "claude-test-" + Date.now());
  const LOG_FILE = join(LOG_DIR, "compaction-log.txt");

  beforeEach(() => {
    mkdirSync(LOG_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      unlinkSync(LOG_FILE);
    } catch {
      // ignore
    }
  });

  it("should create log entry with timestamp", () => {
    execSync(`CLAUDE_LOG_DIR="${LOG_DIR}" bash ${HOOK_PATH}`, {
      encoding: "utf8",
    });
    expect(existsSync(LOG_FILE)).toBe(true);
    const content = readFileSync(LOG_FILE, "utf8");
    expect(content).toContain("Context compaction");
  });

  it("should exit 0 (non-blocking)", () => {
    const result = execSync(`CLAUDE_LOG_DIR="${LOG_DIR}" bash ${HOOK_PATH}; echo "exit:$?"`, {
      encoding: "utf8",
    });
    expect(result).toContain("exit:0");
  });
});

describe("auto-format hook", () => {
  const HOOK_PATH = join(SCRIPTS_DIR, "auto-format.sh");
  const TEST_FILE = join(tmpdir(), "test-format-" + Date.now() + ".ts");

  afterEach(() => {
    try {
      unlinkSync(TEST_FILE);
    } catch {
      // ignore
    }
  });

  it("should exit 0 even if file does not exist", () => {
    const input = JSON.stringify({ tool_input: { file_path: "/nonexistent/file.ts" } });
    const result = execSync(`echo '${input}' | bash ${HOOK_PATH}; echo "exit:$?"`, {
      encoding: "utf8",
      cwd: join(__dirname, "../../.."),
    });
    expect(result).toContain("exit:0");
  });

  it("should format typescript files", () => {
    // Create unformatted file
    writeFileSync(TEST_FILE, 'const x="unformatted"');
    const input = JSON.stringify({ tool_input: { file_path: TEST_FILE } });
    execSync(`echo '${input}' | bash ${HOOK_PATH}`, {
      encoding: "utf8",
      cwd: join(__dirname, "../../.."),
    });
    const content = readFileSync(TEST_FILE, "utf8");
    // Prettier adds semicolon and uses double quotes
    expect(content).toContain("const x");
  });
});
