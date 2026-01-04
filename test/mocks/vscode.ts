import { vi } from "vitest";

/**
 * Creates a mock QuickPick that can be controlled for testing wizardInput
 * Set window._nextQuickPickValue before calling createQuickPick to control the value
 */
let _nextQuickPickValue: string | undefined | symbol;
export const window = {
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  withProgress: vi.fn((opts, task) => task({ report: vi.fn() })),
  createStatusBarItem: vi.fn(() => ({
    text: "",
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })),
  createQuickPick: vi.fn(() => {
    const value = _nextQuickPickValue;
    _nextQuickPickValue = undefined;
    let onAcceptHandler: (() => void) | undefined;
    let onHideHandler: (() => void) | undefined;
    let onChangeHandler: ((value: string) => void) | undefined;
    return {
      title: "",
      placeholder: "",
      items: [],
      selectedItems: [],
      canSelectMany: false,
      value: "",
      onDidChangeValue: (handler: (value: string) => void) => {
        onChangeHandler = handler;
        return { dispose: vi.fn() };
      },
      onDidAccept: (handler: () => void) => {
        onAcceptHandler = handler;
        return { dispose: vi.fn() };
      },
      onDidHide: (handler: () => void) => {
        onHideHandler = handler;
        return { dispose: vi.fn() };
      },
      show: vi.fn(() => {
        // Simulate immediate value entry and accept
        if (value !== undefined) {
          if (typeof value === "symbol") {
            // Back selected
            const qp = { selectedItems: [{ label: "$(arrow-left) Back" }], value: "" };
            Object.assign(qp, { hide: vi.fn() });
            if (onAcceptHandler) {
              const self = qp as unknown as { selectedItems: { label: string }[]; value: string; hide: () => void };
              (window.createQuickPick as ReturnType<typeof vi.fn>).mock.results[
                (window.createQuickPick as ReturnType<typeof vi.fn>).mock.results.length - 1
              ].value.selectedItems = self.selectedItems;
              onAcceptHandler();
            }
          } else {
            // Normal value
            if (onChangeHandler) onChangeHandler(value);
            const qp = (window.createQuickPick as ReturnType<typeof vi.fn>).mock.results[
              (window.createQuickPick as ReturnType<typeof vi.fn>).mock.results.length - 1
            ].value;
            qp.value = value;
            qp.selectedItems = [{ label: `$(check) Accept: "${value}"` }];
            if (onAcceptHandler) onAcceptHandler();
          }
        } else {
          // Cancelled - call hide
          if (onHideHandler) onHideHandler();
        }
      }),
      hide: vi.fn(),
      dispose: vi.fn(),
    };
  }),
  setNextQuickPickValue: (value: string | undefined | symbol) => {
    _nextQuickPickValue = value;
  },
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
export const QuickPickItemKind = { Separator: 1, Default: 0 };

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
