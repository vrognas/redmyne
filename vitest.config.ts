import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: true,
    isolate: false,
    alias: {
      vscode: resolve(__dirname, "./test/mocks/vscode.ts"),
    },
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/extension.ts", // VS Code integration - requires extensive mocking
        "src/trees/**/*.ts", // VS Code TreeProvider - requires extensive mocking
        "src/webviews/**/*.ts", // VS Code Webview - requires extensive mocking
        "src/commands/new-issue.ts", // VS Code UI heavy
        "src/commands/open-actions-for-issue.ts", // VS Code UI heavy
        "src/commands/open-actions-for-issue-under-cursor.ts", // VS Code UI heavy
        "src/commands/commons/**/*.ts", // VS Code UI heavy
        "src/controllers/issue-controller.ts", // VS Code UI heavy - requires integration tests
        "src/redmine/models/**/*.ts", // Type definitions only
        "src/definitions/**/*.ts", // Type definitions only
      ],
      thresholds: {
        lines: 60, // Realistic target for testable code
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
    globals: true,
  },
});
