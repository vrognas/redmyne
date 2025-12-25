import * as vscode from "vscode";

/**
 * Symbol indicating user wants to go back to previous step
 */
export const WIZARD_BACK = Symbol("WIZARD_BACK");

/**
 * QuickPick item with optional data
 */
export interface WizardPickItem<T = unknown> extends vscode.QuickPickItem {
  data?: T;
}

/**
 * Back navigation item for wizard steps
 */
const backItem: WizardPickItem<typeof WIZARD_BACK> = {
  label: "$(arrow-left) Back",
  description: "Return to previous step",
  data: WIZARD_BACK,
  alwaysShow: true,
};

/**
 * Separator between back button and content
 */
const separatorItem: vscode.QuickPickItem = {
  label: "",
  kind: vscode.QuickPickItemKind.Separator,
};

/**
 * Show a QuickPick with optional back navigation
 *
 * @param items Items to show in the picker
 * @param options QuickPick options
 * @param showBack Whether to show back button (false for step 1)
 * @returns Selected item's data, WIZARD_BACK if back selected, undefined if cancelled
 */
export async function wizardPick<T>(
  items: WizardPickItem<T>[],
  options: vscode.QuickPickOptions & { title: string },
  showBack: boolean = false
): Promise<T | typeof WIZARD_BACK | undefined> {
  const allItems = showBack
    ? [backItem as WizardPickItem<T | typeof WIZARD_BACK>, separatorItem, ...items]
    : items;

  const picked = await vscode.window.showQuickPick(allItems, {
    ...options,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) return undefined;

  // Handle back navigation
  if ("data" in picked && picked.data === WIZARD_BACK) {
    return WIZARD_BACK;
  }

  // Return data if present
  if ("data" in picked) {
    return picked.data as T | typeof WIZARD_BACK | undefined;
  }

  return undefined;
}

/**
 * Show an InputBox with back navigation support
 *
 * Uses a QuickPick with editable input instead of InputBox
 * to allow both back navigation and text input
 *
 * @param options InputBox options
 * @param showBack Whether to show back option
 * @returns Input value, WIZARD_BACK if back selected, undefined if cancelled
 */
export async function wizardInput(
  options: vscode.InputBoxOptions & { title: string },
  showBack: boolean = false
): Promise<string | typeof WIZARD_BACK | undefined> {
  if (!showBack) {
    // Simple case - just use regular InputBox
    return vscode.window.showInputBox(options);
  }

  // For back support, we need a workaround since InputBox doesn't support items
  // Use a two-stage approach: first show option to go back, then input
  const quickPick = vscode.window.createQuickPick();
  quickPick.title = options.title;
  quickPick.placeholder = options.placeHolder || "Type to enter value, or select Back";
  quickPick.items = [
    { label: "$(arrow-left) Back", description: "Return to previous step" },
  ];
  quickPick.canSelectMany = false;

  return new Promise<string | typeof WIZARD_BACK | undefined>((resolve) => {
    let resolved = false;

    quickPick.onDidChangeValue((value) => {
      // User is typing - show hint that Enter will submit
      if (value) {
        quickPick.items = [
          { label: `$(check) Accept: "${value}"`, description: "Press Enter to continue" },
          { label: "$(arrow-left) Back", description: "Return to previous step" },
        ];
      } else {
        quickPick.items = [
          { label: "$(arrow-left) Back", description: "Return to previous step" },
        ];
      }
    });

    quickPick.onDidAccept(() => {
      if (resolved) return;
      const selected = quickPick.selectedItems[0];

      if (selected?.label.includes("Back")) {
        resolved = true;
        quickPick.hide();
        resolve(WIZARD_BACK);
        return;
      }

      const value = quickPick.value;

      // Validate if validator provided
      if (options.validateInput && value) {
        const error = options.validateInput(value);
        if (error) {
          // Show validation error - don't accept
          quickPick.items = [
            { label: `$(error) ${error}`, description: "Fix the error and try again" },
            { label: "$(arrow-left) Back", description: "Return to previous step" },
          ];
          return;
        }
      }

      // Check if required
      if (!value && options.validateInput) {
        const error = options.validateInput("");
        if (error) {
          quickPick.items = [
            { label: `$(error) ${error}`, description: "Value is required" },
            { label: "$(arrow-left) Back", description: "Return to previous step" },
          ];
          return;
        }
      }

      resolved = true;
      quickPick.hide();
      resolve(value || "");
    });

    quickPick.onDidHide(() => {
      if (!resolved) {
        resolve(undefined);
      }
      quickPick.dispose();
    });

    quickPick.show();
  });
}

/**
 * Helper to check if result is WIZARD_BACK
 */
export function isBack(result: unknown): result is typeof WIZARD_BACK {
  return result === WIZARD_BACK;
}
