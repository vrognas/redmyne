import { vi } from "vitest";

export const window = {
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  withProgress: vi.fn((opts, task) => task({ report: vi.fn() })),
  createStatusBarItem: vi.fn(() => ({
    text: "",
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })),
};

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: vi.fn(),
    update: vi.fn(),
  })),
  workspaceFolders: [],
  onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
};

export const commands = {
  registerCommand: vi.fn(),
  executeCommand: vi.fn(),
};

export const Uri = {
  parse: (url: string) => ({ toString: () => url }),
};

export const EventEmitter = class {
  private listeners: Array<(e: unknown) => unknown> = [];

  fire = vi.fn((data: unknown) => {
    this.listeners.forEach((listener) => listener(data));
  });

  event = (listener: (e: unknown) => unknown) => {
    this.listeners.push(listener);
    return { dispose: vi.fn() };
  };

  dispose = vi.fn(() => {
    this.listeners = [];
  });
};

export const ProgressLocation = { Notification: 15 };
export const ConfigurationTarget = { WorkspaceFolder: 3, Global: 1 };
export const StatusBarAlignment = { Left: 1, Right: 2 };

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};

export class TreeItem {
  label?: string;
  description?: string;
  command?: { command: string; arguments?: unknown[]; title: string };
  collapsibleState?: number;
  tooltip?: unknown;
  iconPath?: unknown;
  contextValue?: string;

  constructor(label: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class MarkdownString {
  value: string;
  isTrusted?: boolean;
  supportHtml?: boolean;

  constructor(value = "") {
    this.value = value;
  }

  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }
}

export class ThemeColor {
  id: string;

  constructor(id: string) {
    this.id = id;
  }
}

export class ThemeIcon {
  id: string;
  color?: ThemeColor;

  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    this.color = color;
  }
}
