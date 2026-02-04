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
        "src/shared/**/*.ts", // VS Code TreeProvider base - requires extensive mocking
        "src/webviews/**/*.ts", // VS Code Webview - requires extensive mocking
        "src/status-bars/**/*.ts", // VS Code StatusBar - requires mocking
        "src/commands/new-issue.ts", // VS Code UI heavy
        "src/commands/open-actions-for-issue.ts", // VS Code UI heavy
        "src/commands/open-actions-for-issue-under-cursor.ts", // VS Code UI heavy
        "src/commands/commons/**/*.ts", // VS Code UI heavy
        "src/commands/configure-command.ts", // VS Code UI heavy
        "src/commands/create-test-issues.ts", // VS Code UI heavy
        "src/commands/gantt-commands.ts", // VS Code UI heavy
        "src/commands/time-entry-commands.ts", // VS Code UI heavy
        "src/commands/view-commands.ts", // VS Code UI heavy
        "src/commands/monthly-schedule-commands.ts", // VS Code UI heavy
        "src/commands/action-properties.ts", // VS Code integration
        "src/controllers/issue-controller.ts", // VS Code UI heavy - requires integration tests
        "src/timer/timer-commands.ts", // VS Code UI heavy
        "src/timer/timer-dialogs.ts", // VS Code UI heavy
        "src/timer/timer-sound.ts", // Audio playback - requires mocking
        "src/timer/timer-status-bar.ts", // VS Code StatusBar - requires mocking
        "src/timer/timer-tree-provider.ts", // VS Code TreeProvider
        "src/kanban/kanban-commands.ts", // VS Code UI heavy
        "src/kanban/kanban-dialogs.ts", // VS Code UI heavy
        "src/kanban/kanban-tree-provider.ts", // VS Code TreeProvider
        "src/utilities/issue-picker.ts", // VS Code QuickPick - requires mocking
        "src/utilities/auto-update-tracker.ts", // VS Code globalState - requires mocking
        "src/utilities/collapse-state.ts", // VS Code globalState - requires mocking
        "src/utilities/hierarchy-builder.ts", // Complex tree building - needs dedicated tests
        "src/utilities/date-picker.ts", // VS Code QuickPick - requires mocking
        "src/utilities/completion-sound.ts", // Platform-specific audio - requires mocking exec
        "src/redmine/models/**/*.ts", // Type definitions only
        "src/definitions/**/*.ts", // Type definitions only
      ],
      thresholds: {
        lines: 74,
        functions: 76,
        branches: 63,
        statements: 72,
      },
    },
    globals: true,
  },
});
