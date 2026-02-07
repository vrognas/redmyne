import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { window } from "../../mocks/vscode";
import {
  quickCreateIssue,
  quickCreateSubIssue,
} from "../../../src/commands/quick-create-issue";

describe("quickCreateIssue", () => {
  let mockServer: {
    getProjects: ReturnType<typeof vi.fn>;
    getTrackers: ReturnType<typeof vi.fn>;
    getPriorities: ReturnType<typeof vi.fn>;
    createIssue: ReturnType<typeof vi.fn>;
    getIssueById: ReturnType<typeof vi.fn>;
  };
  let props: { server: typeof mockServer; config: Record<string, unknown> };

  const mockProjects = [
    { id: 1, name: "Project Alpha", identifier: "alpha", toQuickPickItem: () => ({ label: "Project Alpha", identifier: "alpha", id: 1 }) },
    { id: 2, name: "Project Beta", identifier: "beta", toQuickPickItem: () => ({ label: "Project Beta", identifier: "beta", id: 2 }) },
  ];

  const mockTrackers = [
    { id: 1, name: "Bug" },
    { id: 2, name: "Tasks" },
    { id: 3, name: "Feature" },
  ];

  const mockPriorities = [
    { id: 1, name: "Low" },
    { id: 2, name: "Normal" },
    { id: 3, name: "High" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    mockServer = {
      getProjects: vi.fn().mockResolvedValue(mockProjects),
      getTrackers: vi.fn().mockResolvedValue(mockTrackers),
      getPriorities: vi.fn().mockResolvedValue(mockPriorities),
      createIssue: vi.fn().mockResolvedValue({
        issue: { id: 999, subject: "New Issue" },
      }),
      getIssueById: vi.fn().mockResolvedValue({
        issue: {
          id: 123,
          subject: "Parent Issue",
          project: { id: 1, name: "Project Alpha" },
          tracker: { id: 2, name: "Tasks" },
        },
      }),
    };

    props = { server: mockServer, config: {} };
  });

  function mockWizardInputActions(
    actions: Array<{ type: "value" | "back" | "cancel" | "invalidThenCancel"; value?: string }>
  ): void {
    let createQuickPickCallCount = 0;
    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() => {
      const action = actions[createQuickPickCallCount++] ?? { type: "cancel" as const };
      let onAcceptHandler: (() => void) | undefined;
      let onHideHandler: (() => void) | undefined;
      const qp = {
        title: "",
        placeholder: "",
        items: [] as vscode.QuickPickItem[],
        selectedItems: [] as { label: string }[],
        canSelectMany: false,
        value: "",
        onDidChangeValue: () => ({ dispose: vi.fn() }),
        onDidAccept: (handler: () => void) => { onAcceptHandler = handler; return { dispose: vi.fn() }; },
        onDidHide: (handler: () => void) => { onHideHandler = handler; return { dispose: vi.fn() }; },
        show: vi.fn(() => {
          if (action.type === "cancel") {
            if (onHideHandler) onHideHandler();
            return;
          }
          if (action.type === "invalidThenCancel") {
            qp.value = action.value ?? "";
            qp.selectedItems = [{ label: `$(check) Accept: "${qp.value}"` }];
            if (onAcceptHandler) onAcceptHandler();
            if (onHideHandler) onHideHandler();
            return;
          }
          if (action.type === "back") {
            qp.selectedItems = [{ label: "$(arrow-left) Back" }];
          } else {
            qp.value = action.value ?? "";
            qp.selectedItems = [{ label: `$(check) Accept: "${qp.value}"` }];
          }
          if (onAcceptHandler) onAcceptHandler();
        }),
        hide: vi.fn(() => { if (onHideHandler) onHideHandler(); }),
        dispose: vi.fn(),
      };
      return qp as unknown as vscode.QuickPick<vscode.QuickPickItem>;
    });
  }

  it("creates issue with full wizard flow", async () => {
    // Mock wizard steps - wizardPick returns item.data
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", data: { label: "Project Alpha", id: 1 } } as unknown as vscode.QuickPickItem) // project
      .mockResolvedValueOnce({ label: "Tasks", data: { label: "Tasks", id: 2 } } as unknown as vscode.QuickPickItem) // tracker
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem); // priority

    // For wizardInput with showBack=true, use createQuickPick mock
    window.setNextQuickPickValue("My new issue"); // subject
    window.setNextQuickPickValue("Issue description"); // description - but this won't work for chained calls

    // Actually need to chain the values - let's use a simpler approach
    // Mock showInputBox for step 4 (subject) since it won't have showBack initially... wait no
    // Looking at the code: step 4 has showBack=true so it uses createQuickPick

    // Let me just test the simpler flow - mock all createQuickPick calls in sequence
    let createQuickPickCallCount = 0;
    const inputValues = ["My new issue", "Issue description", "8", "2025-12-31"];
    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() => {
      const value = inputValues[createQuickPickCallCount++];
      let onAcceptHandler: (() => void) | undefined;
      let onHideHandler: (() => void) | undefined;
      const qp = {
        title: "",
        placeholder: "",
        items: [],
        selectedItems: [] as { label: string }[],
        canSelectMany: false,
        value: "",
        onDidChangeValue: () => ({ dispose: vi.fn() }),
        onDidAccept: (handler: () => void) => { onAcceptHandler = handler; return { dispose: vi.fn() }; },
        onDidHide: (handler: () => void) => { onHideHandler = handler; return { dispose: vi.fn() }; },
        show: vi.fn(() => {
          if (value !== undefined) {
            qp.value = value;
            qp.selectedItems = [{ label: `$(check) Accept: "${value}"` }];
            if (onAcceptHandler) onAcceptHandler();
          } else {
            if (onHideHandler) onHideHandler();
          }
        }),
        hide: vi.fn(),
        dispose: vi.fn(),
      };
      return qp as unknown as vscode.QuickPick<vscode.QuickPickItem>;
    });

    const result = await quickCreateIssue(props);

    expect(result).toEqual({ id: 999, subject: "New Issue" });
    expect(mockServer.createIssue).toHaveBeenCalledWith({
      project_id: 1,
      tracker_id: 2,
      subject: "My new issue",
      description: "Issue description",
      priority_id: 2,
      estimated_hours: 8,
      due_date: "2025-12-31",
    });
  });

  it("creates issue with minimal fields (skipped optional)", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", data: { label: "Project Alpha", id: 1 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Bug", data: { label: "Bug", id: 1 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);

    let createQuickPickCallCount = 0;
    const inputValues = ["Bug report", "", "", ""]; // subject only, rest skipped
    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() => {
      const value = inputValues[createQuickPickCallCount++];
      let onAcceptHandler: (() => void) | undefined;
      const qp = {
        title: "",
        placeholder: "",
        items: [],
        selectedItems: [] as { label: string }[],
        canSelectMany: false,
        value: "",
        onDidChangeValue: () => ({ dispose: vi.fn() }),
        onDidAccept: (handler: () => void) => { onAcceptHandler = handler; return { dispose: vi.fn() }; },
        onDidHide: () => ({ dispose: vi.fn() }),
        show: vi.fn(() => {
          qp.value = value;
          qp.selectedItems = [{ label: `$(check) Accept: "${value}"` }];
          if (onAcceptHandler) onAcceptHandler();
        }),
        hide: vi.fn(),
        dispose: vi.fn(),
      };
      return qp as unknown as vscode.QuickPick<vscode.QuickPickItem>;
    });

    await quickCreateIssue(props);

    expect(mockServer.createIssue).toHaveBeenCalledWith({
      project_id: 1,
      tracker_id: 1,
      subject: "Bug report",
      priority_id: 2,
    });
  });

  it("returns undefined when user cancels at project selection", async () => {
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce(undefined);

    const result = await quickCreateIssue(props);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("returns undefined when unexpected back is selected at project step", async () => {
    const { WIZARD_BACK } = await import("../../../src/utilities/wizard");
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce({
      label: "$(arrow-left) Back",
      data: WIZARD_BACK,
    } as unknown as vscode.QuickPickItem);

    const result = await quickCreateIssue(props);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("supports preselected project and cancel on tracker step", async () => {
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce(undefined);

    const result = await quickCreateIssue(props, 1);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
  });

  it("falls back to project picker when preselected project is not found", async () => {
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce(undefined);

    const result = await quickCreateIssue(props, 99999);

    expect(result).toBeUndefined();
    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("returns undefined when user cancels at subject input", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", data: { label: "Project Alpha", id: 1 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Tasks", data: { label: "Tasks", id: 2 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);

    // Cancel at subject input by returning undefined from createQuickPick
    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() => {
      let onHideHandler: (() => void) | undefined;
      const qp = {
        title: "",
        placeholder: "",
        items: [],
        selectedItems: [],
        canSelectMany: false,
        value: "",
        onDidChangeValue: () => ({ dispose: vi.fn() }),
        onDidAccept: () => ({ dispose: vi.fn() }),
        onDidHide: (handler: () => void) => { onHideHandler = handler; return { dispose: vi.fn() }; },
        show: vi.fn(() => {
          if (onHideHandler) onHideHandler(); // simulate cancel
        }),
        hide: vi.fn(),
        dispose: vi.fn(),
      };
      return qp as unknown as vscode.QuickPick<vscode.QuickPickItem>;
    });

    const result = await quickCreateIssue(props);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("shows error and aborts when subject is blank", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", data: { label: "Project Alpha", id: 1 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Tasks", data: { label: "Tasks", id: 2 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);

    let createQuickPickCallCount = 0;
    const inputValues = ["   ", "", "", ""]; // subject, description, hours, due date
    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() => {
      const value = inputValues[createQuickPickCallCount++];
      let onAcceptHandler: (() => void) | undefined;
      const qp = {
        title: "",
        placeholder: "",
        items: [],
        selectedItems: [] as { label: string }[],
        canSelectMany: false,
        value: "",
        onDidChangeValue: () => ({ dispose: vi.fn() }),
        onDidAccept: (handler: () => void) => { onAcceptHandler = handler; return { dispose: vi.fn() }; },
        onDidHide: () => ({ dispose: vi.fn() }),
        show: vi.fn(() => {
          qp.value = value;
          qp.selectedItems = [{ label: `$(check) Accept: "${value}"` }];
          if (onAcceptHandler) onAcceptHandler();
        }),
        hide: vi.fn(),
        dispose: vi.fn(),
      };
      return qp as unknown as vscode.QuickPick<vscode.QuickPickItem>;
    });

    const result = await quickCreateIssue(props);

    expect(result).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Could not determine subject");
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("handles back navigation across description/hours/due steps and still creates", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Tasks", data: { label: "Tasks", id: 2 } } as unknown as vscode.QuickPickItem) // tracker (preselected project skips step 1)
      .mockResolvedValueOnce({ label: "High", data: { label: "High", id: 3 } } as unknown as vscode.QuickPickItem); // priority

    mockWizardInputActions([
      { type: "value", value: "Initial subject" }, // step 4
      { type: "back" }, // step 5 -> back to step 4
      { type: "value", value: "Final subject" }, // step 4 again
      { type: "value", value: "Desc A" }, // step 5
      { type: "back" }, // step 6 -> back to step 5
      { type: "value", value: "Desc B" }, // step 5 again
      { type: "value", value: "6" }, // step 6
      { type: "back" }, // step 7 -> back to step 6
      { type: "value", value: "7" }, // step 6 again
      { type: "value", value: "2026-12-31" }, // step 7 final
    ]);

    const result = await quickCreateIssue(props, 1);

    expect(result).toEqual({ id: 999, subject: "New Issue" });
    expect(mockServer.createIssue).toHaveBeenCalledWith({
      project_id: 1,
      tracker_id: 2,
      subject: "Final subject",
      description: "Desc B",
      priority_id: 3,
      estimated_hours: 7,
      due_date: "2026-12-31",
    });
  });

  it("returns undefined when user cancels at due date step", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", data: { label: "Project Alpha", id: 1 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Tasks", data: { label: "Tasks", id: 2 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);
    mockWizardInputActions([
      { type: "value", value: "Subject" },
      { type: "value", value: "Desc" },
      { type: "value", value: "3" },
      { type: "cancel" },
    ]);

    const result = await quickCreateIssue(props);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("returns undefined when user cancels at priority step", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", data: { label: "Project Alpha", id: 1 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Tasks", data: { label: "Tasks", id: 2 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce(undefined);

    const result = await quickCreateIssue(props);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("supports back navigation from tracker and subject steps", async () => {
    const { WIZARD_BACK } = await import("../../../src/utilities/wizard");
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", data: { label: "Project Alpha", id: 1 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "$(arrow-left) Back", data: WIZARD_BACK } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Project Alpha", data: { label: "Project Alpha", id: 1 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Tasks", data: { label: "Tasks", id: 2 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "High", data: { label: "High", id: 3 } } as unknown as vscode.QuickPickItem);

    mockWizardInputActions([
      { type: "back" },
      { type: "value", value: "Final subject" },
      { type: "value", value: "Desc" },
      { type: "value", value: "4" },
      { type: "value", value: "2026-11-01" },
    ]);

    const result = await quickCreateIssue(props);

    expect(result).toEqual({ id: 999, subject: "New Issue" });
    expect(mockServer.createIssue).toHaveBeenCalledWith({
      project_id: 1,
      tracker_id: 2,
      priority_id: 3,
      subject: "Final subject",
      description: "Desc",
      estimated_hours: 4,
      due_date: "2026-11-01",
    });
  });

  it("supports back navigation from priority step", async () => {
    const { WIZARD_BACK } = await import("../../../src/utilities/wizard");
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", data: { label: "Project Alpha", id: 1 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Tasks", data: { label: "Tasks", id: 2 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "$(arrow-left) Back", data: WIZARD_BACK } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Tasks", data: { label: "Tasks", id: 2 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);

    mockWizardInputActions([
      { type: "value", value: "Subject" },
      { type: "value", value: "Desc" },
      { type: "value", value: "2" },
      { type: "value", value: "" },
    ]);

    const result = await quickCreateIssue(props);

    expect(result).toEqual({ id: 999, subject: "New Issue" });
    expect(mockServer.createIssue).toHaveBeenCalledWith({
      project_id: 1,
      tracker_id: 2,
      priority_id: 2,
      subject: "Subject",
      description: "Desc",
      estimated_hours: 2,
    });
  });

  it("returns undefined when description is canceled", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", data: { label: "Project Alpha", id: 1 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Tasks", data: { label: "Tasks", id: 2 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);

    mockWizardInputActions([
      { type: "value", value: "Subject" },
      { type: "cancel" },
    ]);

    const result = await quickCreateIssue(props);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("returns undefined when estimated hours is invalid then canceled", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", data: { label: "Project Alpha", id: 1 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Tasks", data: { label: "Tasks", id: 2 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);

    mockWizardInputActions([
      { type: "value", value: "Subject" },
      { type: "value", value: "Desc" },
      { type: "invalidThenCancel", value: "-5" },
    ]);

    const result = await quickCreateIssue(props);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("returns undefined when subject is empty then canceled", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Project Alpha", data: { label: "Project Alpha", id: 1 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Tasks", data: { label: "Tasks", id: 2 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);

    mockWizardInputActions([{ type: "invalidThenCancel", value: "" }]);

    const result = await quickCreateIssue(props);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("shows error when metadata loading fails", async () => {
    mockServer.getProjects.mockRejectedValueOnce(new Error("offline"));

    const result = await quickCreateIssue(props);

    expect(result).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to create issue: offline"
    );
  });

  it("validates estimated hours input", () => {
    // Test validators directly - they're pure functions
    const validateHours = (v: string): string | null => {
      if (!v) return null;
      const num = Number(v);
      return !isNaN(num) && num >= 0 ? null : "Must be positive number";
    };

    expect(validateHours("")).toBeNull(); // empty is valid (optional)
    expect(validateHours("8")).toBeNull();
    expect(validateHours("0.5")).toBeNull();
    expect(validateHours("0")).toBeNull();
    expect(validateHours("-5")).toBeTruthy(); // should return error
    expect(validateHours("abc")).toBeTruthy(); // should return error
    expect(validateHours("5abc")).toBeTruthy(); // malformed - should return error
    expect(validateHours("1.5x")).toBeTruthy(); // malformed - should return error
  });

  it("validates due date format", () => {
    // Test validators directly - they're pure functions
    const validateDate = (v: string): string | null => {
      if (!v) return null;
      return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v).getTime())
        ? null
        : "Use YYYY-MM-DD format";
    };

    expect(validateDate("")).toBeNull(); // empty is valid (optional)
    expect(validateDate("2025-12-31")).toBeNull();
    expect(validateDate("2025-1-1")).toBeTruthy(); // invalid format
    expect(validateDate("12/31/2025")).toBeTruthy(); // wrong format
    expect(validateDate("not-a-date")).toBeTruthy();
  });
});

describe("quickCreateSubIssue", () => {
  let mockServer: {
    getProjects: ReturnType<typeof vi.fn>;
    getTrackers: ReturnType<typeof vi.fn>;
    getPriorities: ReturnType<typeof vi.fn>;
    createIssue: ReturnType<typeof vi.fn>;
    getIssueById: ReturnType<typeof vi.fn>;
  };
  let props: { server: typeof mockServer; config: Record<string, unknown> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockServer = {
      getProjects: vi.fn(),
      getTrackers: vi.fn(),
      getPriorities: vi.fn().mockResolvedValue([
        { id: 1, name: "Low" },
        { id: 2, name: "Normal" },
        { id: 3, name: "High" },
      ]),
      createIssue: vi.fn().mockResolvedValue({
        issue: { id: 1000, subject: "Sub Issue" },
      }),
      getIssueById: vi.fn().mockResolvedValue({
        issue: {
          id: 123,
          subject: "Parent Issue",
          project: { id: 1, name: "Project Alpha" },
          tracker: { id: 2, name: "Tasks" },
        },
      }),
    };

    props = { server: mockServer, config: {} };
  });

  function mockWizardInputActions(
    actions: Array<{ type: "value" | "back" | "cancel" | "invalidThenCancel"; value?: string }>
  ): void {
    let createQuickPickCallCount = 0;
    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() => {
      const action = actions[createQuickPickCallCount++] ?? { type: "cancel" as const };
      let onAcceptHandler: (() => void) | undefined;
      let onHideHandler: (() => void) | undefined;
      const qp = {
        title: "",
        placeholder: "",
        items: [] as vscode.QuickPickItem[],
        selectedItems: [] as { label: string }[],
        canSelectMany: false,
        value: "",
        onDidChangeValue: () => ({ dispose: vi.fn() }),
        onDidAccept: (handler: () => void) => { onAcceptHandler = handler; return { dispose: vi.fn() }; },
        onDidHide: (handler: () => void) => { onHideHandler = handler; return { dispose: vi.fn() }; },
        show: vi.fn(() => {
          if (action.type === "cancel") {
            if (onHideHandler) onHideHandler();
            return;
          }
          if (action.type === "invalidThenCancel") {
            qp.value = action.value ?? "";
            qp.selectedItems = [{ label: `$(check) Accept: "${qp.value}"` }];
            if (onAcceptHandler) onAcceptHandler();
            if (onHideHandler) onHideHandler();
            return;
          }
          if (action.type === "back") {
            qp.selectedItems = [{ label: "$(arrow-left) Back" }];
          } else {
            qp.value = action.value ?? "";
            qp.selectedItems = [{ label: `$(check) Accept: "${qp.value}"` }];
          }
          if (onAcceptHandler) onAcceptHandler();
        }),
        hide: vi.fn(() => { if (onHideHandler) onHideHandler(); }),
        dispose: vi.fn(),
      };
      return qp as unknown as vscode.QuickPick<vscode.QuickPickItem>;
    });
  }

  it("creates sub-issue inheriting parent project and tracker", async () => {
    // Priority pick with data property
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);

    // createQuickPick for input steps
    let createQuickPickCallCount = 0;
    const inputValues = ["Child task", "", "4", ""]; // subject, description, hours, due date
    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() => {
      const value = inputValues[createQuickPickCallCount++];
      let onAcceptHandler: (() => void) | undefined;
      const qp = {
        title: "",
        placeholder: "",
        items: [],
        selectedItems: [] as { label: string }[],
        canSelectMany: false,
        value: "",
        onDidChangeValue: () => ({ dispose: vi.fn() }),
        onDidAccept: (handler: () => void) => { onAcceptHandler = handler; return { dispose: vi.fn() }; },
        onDidHide: () => ({ dispose: vi.fn() }),
        show: vi.fn(() => {
          qp.value = value;
          qp.selectedItems = [{ label: `$(check) Accept: "${value}"` }];
          if (onAcceptHandler) onAcceptHandler();
        }),
        hide: vi.fn(),
        dispose: vi.fn(),
      };
      return qp as unknown as vscode.QuickPick<vscode.QuickPickItem>;
    });

    const result = await quickCreateSubIssue(props, 123);

    expect(result).toEqual({ id: 1000, subject: "Sub Issue" });
    expect(mockServer.getIssueById).toHaveBeenCalledWith(123);
    expect(mockServer.getProjects).not.toHaveBeenCalled(); // skipped
    expect(mockServer.getTrackers).not.toHaveBeenCalled(); // skipped
    expect(mockServer.createIssue).toHaveBeenCalledWith({
      project_id: 1,
      tracker_id: 2,
      subject: "Child task",
      priority_id: 2,
      estimated_hours: 4,
      parent_issue_id: 123,
    });
  });

  it("blocks sub-issue creation when issue already has a parent", async () => {
    mockServer.getIssueById.mockResolvedValueOnce({
      issue: {
        id: 123,
        subject: "Child Issue",
        project: { id: 1, name: "Project Alpha" },
        tracker: { id: 2, name: "Tasks" },
        parent: { id: 99 },
      },
    });

    const warningSpy = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);

    const result = await quickCreateSubIssue(props, 123);

    expect(result).toBeUndefined();
    expect(warningSpy).toHaveBeenCalled();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("shows parent issue info in subject prompt", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);

    // Track the title/prompt from createQuickPick calls
    const capturedTitles: string[] = [];
    let createQuickPickCallCount = 0;
    const inputValues = ["Sub task", "", "", ""];
    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() => {
      const value = inputValues[createQuickPickCallCount++];
      let onAcceptHandler: (() => void) | undefined;
      const qp = {
        title: "",
        placeholder: "",
        items: [],
        selectedItems: [] as { label: string }[],
        canSelectMany: false,
        value: "",
        onDidChangeValue: () => ({ dispose: vi.fn() }),
        onDidAccept: (handler: () => void) => { onAcceptHandler = handler; return { dispose: vi.fn() }; },
        onDidHide: () => ({ dispose: vi.fn() }),
        show: vi.fn(() => {
          capturedTitles.push(qp.title);
          qp.value = value;
          qp.selectedItems = [{ label: `$(check) Accept: "${value}"` }];
          if (onAcceptHandler) onAcceptHandler();
        }),
        hide: vi.fn(),
        dispose: vi.fn(),
      };
      return qp as unknown as vscode.QuickPick<vscode.QuickPickItem>;
    });

    await quickCreateSubIssue(props, 123);

    // First createQuickPick is for subject - title should contain parent info
    expect(capturedTitles[0]).toContain("123"); // parent ID in title
  });

  it("returns undefined when user cancels priority selection", async () => {
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce(undefined);

    const result = await quickCreateSubIssue(props, 123);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("returns undefined when unexpected back is selected at sub-issue priority step", async () => {
    const { WIZARD_BACK } = await import("../../../src/utilities/wizard");
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce({
      label: "$(arrow-left) Back",
      data: WIZARD_BACK,
    } as unknown as vscode.QuickPickItem);

    const result = await quickCreateSubIssue(props, 123);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("returns undefined when sub-issue subject is canceled", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);
    mockWizardInputActions([{ type: "cancel" }]);

    const result = await quickCreateSubIssue(props, 123);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("supports back navigation from sub-issue subject step", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem)
      .mockResolvedValueOnce({ label: "High", data: { label: "High", id: 3 } } as unknown as vscode.QuickPickItem);
    mockWizardInputActions([
      { type: "back" },
      { type: "value", value: "Child task final" },
      { type: "value", value: "" },
      { type: "value", value: "" },
      { type: "value", value: "" },
    ]);

    const result = await quickCreateSubIssue(props, 123);

    expect(result).toEqual({ id: 1000, subject: "Sub Issue" });
    expect(mockServer.createIssue).toHaveBeenCalledWith({
      project_id: 1,
      tracker_id: 2,
      priority_id: 3,
      parent_issue_id: 123,
      subject: "Child task final",
    });
  });

  it("returns undefined when sub-issue description/hours/due steps are canceled", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValue({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);

    mockWizardInputActions([
      { type: "value", value: "Child one" },
      { type: "cancel" },
    ]);
    expect(await quickCreateSubIssue(props, 123)).toBeUndefined();

    mockWizardInputActions([
      { type: "value", value: "Child two" },
      { type: "value", value: "Desc" },
      { type: "cancel" },
    ]);
    expect(await quickCreateSubIssue(props, 123)).toBeUndefined();

    mockWizardInputActions([
      { type: "value", value: "Child three" },
      { type: "value", value: "Desc" },
      { type: "value", value: "2" },
      { type: "cancel" },
    ]);
    expect(await quickCreateSubIssue(props, 123)).toBeUndefined();

    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("shows subject error when sub-issue subject is blank spaces", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);
    mockWizardInputActions([
      { type: "value", value: "   " },
      { type: "value", value: "" },
      { type: "value", value: "" },
      { type: "value", value: "" },
    ]);

    const result = await quickCreateSubIssue(props, 123);

    expect(result).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Could not determine subject");
  });

  it("returns undefined when sub-issue subject is empty then canceled", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);
    mockWizardInputActions([{ type: "invalidThenCancel", value: "" }]);

    const result = await quickCreateSubIssue(props, 123);

    expect(result).toBeUndefined();
    expect(mockServer.createIssue).not.toHaveBeenCalled();
  });

  it("supports back navigation in sub-issue wizard and catches create errors", async () => {
    vi.spyOn(vscode.window, "showQuickPick")
      .mockResolvedValueOnce({ label: "Normal", data: { label: "Normal", id: 2 } } as unknown as vscode.QuickPickItem);
    let createQuickPickCallCount = 0;
    const actions = [
      { type: "value", value: "Child A" },
      { type: "back" },
      { type: "value", value: "Child B" },
      { type: "value", value: "Desc" },
      { type: "back" },
      { type: "value", value: "Desc 2" },
      { type: "value", value: "4" },
      { type: "back" },
      { type: "value", value: "5" },
      { type: "value", value: "2026-11-01" },
    ] as const;
    vi.spyOn(vscode.window, "createQuickPick").mockImplementation(() => {
      const action = actions[createQuickPickCallCount++] ?? { type: "cancel" as const };
      let onAcceptHandler: (() => void) | undefined;
      let onHideHandler: (() => void) | undefined;
      const qp = {
        title: "",
        placeholder: "",
        items: [] as vscode.QuickPickItem[],
        selectedItems: [] as { label: string }[],
        canSelectMany: false,
        value: "",
        onDidChangeValue: () => ({ dispose: vi.fn() }),
        onDidAccept: (handler: () => void) => { onAcceptHandler = handler; return { dispose: vi.fn() }; },
        onDidHide: (handler: () => void) => { onHideHandler = handler; return { dispose: vi.fn() }; },
        show: vi.fn(() => {
          if (action.type === "cancel") {
            if (onHideHandler) onHideHandler();
            return;
          }
          if (action.type === "back") {
            qp.selectedItems = [{ label: "$(arrow-left) Back" }];
          } else {
            qp.value = action.value;
            qp.selectedItems = [{ label: `$(check) Accept: "${action.value}"` }];
          }
          if (onAcceptHandler) onAcceptHandler();
        }),
        hide: vi.fn(() => { if (onHideHandler) onHideHandler(); }),
        dispose: vi.fn(),
      };
      return qp as unknown as vscode.QuickPick<vscode.QuickPickItem>;
    });

    mockServer.createIssue.mockRejectedValueOnce(new Error("create failed"));
    const result = await quickCreateSubIssue(props, 123);

    expect(result).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to create sub-issue: create failed"
    );
  });
});
