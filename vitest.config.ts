import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: true,
    isolate: true,
    alias: {
      vscode: resolve(__dirname, "./test/mocks/vscode.ts"),
    },
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/extension.ts", // VS Code activation entry point
        "src/commands/new-issue.ts", // VS Code UI heavy
        "src/commands/open-actions-for-issue.ts", // VS Code UI heavy
        "src/commands/open-actions-for-issue-under-cursor.ts", // VS Code UI heavy
        "src/commands/commons/**/*.ts", // VS Code UI heavy
        "src/commands/action-properties.ts", // Type-only interface
        "src/timer/**/*.ts", // VS Code UI heavy + audio
        "src/utilities/issue-picker.ts", // VS Code QuickPick
        "src/utilities/completion-sound.ts", // Platform-specific audio
        "src/redmine/models/**/*.ts", // Type definitions only
        "src/definitions/**/*.ts", // Type definitions only
      ],
      thresholds: {
        lines: 88,
        functions: 78,
        branches: 72,
        statements: 88,
      },
    },
    globals: true,
  },
});
