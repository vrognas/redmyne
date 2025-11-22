import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    alias: {
      vscode: resolve(__dirname, "./test/mocks/vscode.ts"),
    },
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 60, // Realistic target
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
    globals: true,
  },
});
