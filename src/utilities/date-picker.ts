/**
 * Shared date picker utility
 */

import * as vscode from "vscode";

const formatDateISO = (d: Date) => d.toISOString().split("T")[0];
const formatDisplay = (d: Date) =>
  d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

export interface DatePickerOptions {
  /** Allow future dates (default: false for time logging, true for scheduling) */
  allowFuture?: boolean;
  /** Show "Yesterday" option (default: true) */
  showYesterday?: boolean;
  /** Show "Tomorrow" and "Next week" options (default: false) */
  showFutureDates?: boolean;
}

/**
 * Pick a date for time logging (Today, Yesterday, or custom)
 * Returns YYYY-MM-DD string or undefined if cancelled
 */
export async function pickDate(
  options?: DatePickerOptions
): Promise<string | undefined> {
  const today = new Date();
  const todayStr = formatDateISO(today);
  const allowFuture = options?.allowFuture ?? false;
  const showYesterday = options?.showYesterday ?? true;
  const showFutureDates = options?.showFutureDates ?? false;

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = formatDateISO(yesterday);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const nextWeek = new Date(today);
  nextWeek.setDate(nextWeek.getDate() + 7);

  type DateOption = { label: string; value: string; action: "preset" | "pick" };
  const items: DateOption[] = [
    { label: `$(calendar) Today (${formatDisplay(today)})`, value: todayStr, action: "preset" },
  ];

  if (showYesterday) {
    items.push({
      label: `$(history) Yesterday (${formatDisplay(yesterday)})`,
      value: yesterdayStr,
      action: "preset",
    });
  }

  if (showFutureDates) {
    items.push(
      { label: `$(arrow-right) Tomorrow (${formatDisplay(tomorrow)})`, value: formatDateISO(tomorrow), action: "preset" },
      { label: `$(arrow-right) Next week (${formatDisplay(nextWeek)})`, value: formatDateISO(nextWeek), action: "preset" }
    );
  }

  items.push({ label: "$(edit) Pick date...", value: "", action: "pick" });

  const choice = await vscode.window.showQuickPick(items, {
    title: "Select Date",
    placeHolder: "Which day?",
  });

  if (!choice) return undefined;

  if (choice.action === "pick") {
    const customDate = await vscode.window.showInputBox({
      prompt: "Enter date (YYYY-MM-DD)",
      placeHolder: yesterdayStr,
      validateInput: (value) => validateDateInput(value, allowFuture),
    });
    return customDate;
  }

  return choice.value;
}

export interface EditDateResult {
  changed: boolean;
  value: string | null;
}

/**
 * Pick/edit a date for issue update (with No change, Clear options)
 * Returns { changed, value } or undefined if cancelled
 */
export async function pickOptionalDate(
  label: string,
  currentValue: string | undefined,
  title: string
): Promise<EditDateResult | undefined> {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextWeek = new Date(today);
  nextWeek.setDate(nextWeek.getDate() + 7);

  type DateEditOption = { label: string; value: string | null; action: string };
  const options: DateEditOption[] = [
    { label: "$(check) No change", value: currentValue || null, action: "nochange" },
  ];

  if (currentValue) {
    options.push({ label: "$(close) Clear date", value: null, action: "clear" });
  }

  options.push(
    { label: `$(calendar) Today (${formatDisplay(today)})`, value: formatDateISO(today), action: "set" },
    { label: `$(arrow-right) Tomorrow (${formatDisplay(tomorrow)})`, value: formatDateISO(tomorrow), action: "set" },
    { label: `$(arrow-right) Next week (${formatDisplay(nextWeek)})`, value: formatDateISO(nextWeek), action: "set" },
    { label: "$(edit) Pick date...", value: "", action: "pick" }
  );

  const choice = await vscode.window.showQuickPick(options, {
    title,
    placeHolder: `${label}: ${currentValue || "not set"}`,
  });

  if (!choice) return undefined;

  if (choice.action === "nochange") {
    return { changed: false, value: null };
  }

  if (choice.action === "clear") {
    return { changed: true, value: null };
  }

  if (choice.action === "pick") {
    const customDate = await vscode.window.showInputBox({
      title,
      prompt: `Enter ${label.toLowerCase()} (YYYY-MM-DD)`,
      placeHolder: currentValue || formatDateISO(today),
      validateInput: (value) => {
        if (!value) return `${label} required`;
        return validateDateInput(value, true);
      },
    });
    if (customDate === undefined) return undefined;
    return { changed: true, value: customDate };
  }

  // "set" action (today/tomorrow/next week)
  return { changed: true, value: choice.value };
}

/**
 * Validate date input string (YYYY-MM-DD)
 * Returns error message or null if valid
 */
export function validateDateInput(
  value: string,
  allowFuture = false
): string | null {
  if (!value) return "Date required";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Use YYYY-MM-DD format";
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return "Invalid date";
  if (!allowFuture && parsed > new Date()) return "Cannot log time in the future";
  return null;
}
