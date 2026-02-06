import { describe, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT_DIR = join(__dirname, "../../..");
const SRC_DIR = join(ROOT_DIR, "src");
const PACKAGE_JSON_PATH = join(ROOT_DIR, "package.json");
const PERCENT_OPTIONS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

const INTERNAL_ONLY_COMMANDS = new Set<string>([
  "redmyne.bulkSetDoneRatio",
  "redmyne.gantt.setPriorityHigh",
  "redmyne.gantt.setPriorityImmediate",
  "redmyne.gantt.setPriorityLow",
  "redmyne.gantt.setPriorityNormal",
  "redmyne.gantt.setPriorityOther",
  "redmyne.gantt.setPriorityUrgent",
  "redmyne.gantt.setStatusClosed",
  "redmyne.gantt.setStatusInProgress",
  "redmyne.gantt.setStatusNew",
  "redmyne.gantt.setStatusOther",
  "redmyne.gantt.toggleAdHoc",
  "redmyne.gantt.toggleAutoUpdate",
  "redmyne.gantt.togglePrecedence",
  "redmyne.refreshAfterIssueUpdate",
  "redmyne.refreshGanttData",
  "redmyne.refreshTimesheet",
  "redmyne.revealIssueInTree",
  "redmyne.revealProjectInTree",
  "redmyne.setAdHoc",
  "redmyne.setAutoUpdateDoneRatio",
  "redmyne.setIssueStatus",
  "redmyne.setPrecedence",
  "redmyne.setPriorityHigh",
  "redmyne.setPriorityImmediate",
  "redmyne.setPriorityLow",
  "redmyne.setPriorityNormal",
  "redmyne.setPriorityOther",
  "redmyne.setPriorityUrgent",
  "redmyne.setStatusClosed",
  "redmyne.setStatusInProgress",
  "redmyne.setStatusNew",
  "redmyne.setStatusOther",
]);

type PackageJson = {
  contributes?: {
    commands?: Array<{
      command: string;
    }>;
  };
};

function walkFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function addGeneratedDoneRatioCommands(commands: Set<string>, prefix: string): void {
  for (const percent of PERCENT_OPTIONS) {
    commands.add(`${prefix}${percent}`);
  }
}

function extractRegisteredCommands(filePath: string, source: string): Set<string> {
  const commands = new Set<string>();
  const isExtensionFile = basename(filePath) === "extension.ts";
  const usesConfiguredRegister = source.includes("registerConfiguredCommand");

  const quotedRegistrations = source.matchAll(/registerCommand\(\s*["']([^"']+)["']/g);
  for (const match of quotedRegistrations) {
    const command = match[1];
    if (command.startsWith("redmyne.")) {
      commands.add(command);
      continue;
    }

    if (isExtensionFile || usesConfiguredRegister) {
      commands.add(`redmyne.${command}`);
    }
  }

  const templateRegistrations = source.matchAll(/registerCommand\(\s*`([^`]+)`/g);
  for (const match of templateRegistrations) {
    const command = match[1];

    if (command === "redmyne.gantt.setDoneRatio${pct}") {
      addGeneratedDoneRatioCommands(commands, "redmyne.gantt.setDoneRatio");
      continue;
    }

    if (command === "redmyne.setDoneRatio${pct}") {
      addGeneratedDoneRatioCommands(commands, "redmyne.setDoneRatio");
      continue;
    }

    if (command.includes("${")) {
      continue;
    }

    if (command.startsWith("redmyne.")) {
      commands.add(command);
    }
  }

  return commands;
}

function getRegisteredCommandsFromSource(): Set<string> {
  const files = walkFiles(SRC_DIR).filter((filePath) => filePath.endsWith(".ts"));
  const commands = new Set<string>();

  for (const filePath of files) {
    const source = readFileSync(filePath, "utf8");
    for (const command of extractRegisteredCommands(filePath, source)) {
      commands.add(command);
    }
  }

  return commands;
}

function getContributedCommandsFromManifest(): Set<string> {
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as PackageJson;
  const commands = packageJson.contributes?.commands ?? [];
  return new Set(commands.map((entry) => entry.command));
}

describe("command manifest contract", () => {
  it("registers every contributed command in source", () => {
    const contributed = getContributedCommandsFromManifest();
    const registered = getRegisteredCommandsFromSource();
    const missing = [...contributed].filter((command) => !registered.has(command)).sort();

    if (missing.length > 0) {
      throw new Error(
        `Commands in package.json without registration:\n${missing.join("\n")}`
      );
    }
  });

  it("documents every internal-only registered command", () => {
    const contributed = getContributedCommandsFromManifest();
    const registered = getRegisteredCommandsFromSource();
    const internalOnly = [...registered]
      .filter((command) => !contributed.has(command))
      .sort();

    const undocumented = internalOnly.filter(
      (command) => !INTERNAL_ONLY_COMMANDS.has(command)
    );

    if (undocumented.length > 0) {
      throw new Error(
        `Internal commands missing allowlist entries:\n${undocumented.join("\n")}`
      );
    }
  });
});
