import { vi } from "vitest";

export const window = {
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  withProgress: vi.fn((opts, task) => task({ report: vi.fn() })),
};

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: vi.fn(),
    update: vi.fn(),
  })),
  workspaceFolders: [],
};

export const commands = {
  registerCommand: vi.fn(),
  executeCommand: vi.fn(),
};

export const Uri = {
  parse: (url: string) => ({ toString: () => url }),
};

export const EventEmitter = class {
  fire = vi.fn();
  event = vi.fn();
};

export const ProgressLocation = { Notification: 15 };
export const ConfigurationTarget = { WorkspaceFolder: 3 };
