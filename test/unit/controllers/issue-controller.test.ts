import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { IssueController } from "../../../src/controllers/issue-controller";
import {
  IssueStatus as TypedIssueStatus,
  Membership,
  QuickUpdateResult,
} from "../../../src/controllers/domain";
import type { Issue } from "../../../src/redmine/models/issue";
import type {
  IssuePriority,
  IssueStatus as RedmineIssueStatus,
  TimeEntryActivity,
} from "../../../src/redmine/models/common";
import * as closedIssueGuard from "../../../src/utilities/closed-issue-guard";
import * as customFieldPicker from "../../../src/utilities/custom-field-picker";
import * as datePicker from "../../../src/utilities/date-picker";
import * as statusBar from "../../../src/utilities/status-bar";

type MockServer = {
  options: { address: string };
  getTimeEntryCustomFields: ReturnType<typeof vi.fn>;
  addTimeEntry: ReturnType<typeof vi.fn>;
  setIssueStatus: ReturnType<typeof vi.fn>;
  setIssuePriority: ReturnType<typeof vi.fn>;
  getIssueStatuses: ReturnType<typeof vi.fn>;
  getIssuePriorities: ReturnType<typeof vi.fn>;
  getProjectTimeEntryActivities: ReturnType<typeof vi.fn>;
  getMemberships: ReturnType<typeof vi.fn>;
  getIssueStatusesTyped: ReturnType<typeof vi.fn>;
  applyQuickUpdate: ReturnType<typeof vi.fn>;
  getIssueWithJournals: ReturnType<typeof vi.fn>;
};

function createIssue(overrides: Partial<Issue> = {}): Issue {
  const base: Issue = {
    id: 123,
    project: { id: 7, name: "Platform" },
    tracker: { id: 1, name: "Task" },
    status: { id: 1, name: "Open", is_closed: false },
    priority: { id: 2, name: "Normal" },
    author: { id: 1, name: "Author" },
    assigned_to: { id: 11, name: "Alice" },
    subject: "Improve tests",
    description: "",
    start_date: "2026-02-01",
    due_date: "2026-02-10",
    done_ratio: 0,
    is_private: false,
    estimated_hours: null,
    created_on: "2026-02-01T00:00:00Z",
    updated_on: "2026-02-01T00:00:00Z",
    closed_on: null,
  };

  return {
    ...base,
    ...overrides,
    project: { ...base.project, ...(overrides.project ?? {}) },
    tracker: { ...base.tracker, ...(overrides.tracker ?? {}) },
    status: { ...base.status, ...(overrides.status ?? {}) },
    priority: { ...base.priority, ...(overrides.priority ?? {}) },
    author: { ...base.author, ...(overrides.author ?? {}) },
    assigned_to: { ...base.assigned_to, ...(overrides.assigned_to ?? {}) },
  };
}

function createMockServer(overrides: Partial<MockServer> = {}): MockServer {
  return {
    options: { address: "https://redmine.example.test" },
    getTimeEntryCustomFields: vi.fn().mockResolvedValue([]),
    addTimeEntry: vi.fn().mockResolvedValue(undefined),
    setIssueStatus: vi.fn().mockResolvedValue(undefined),
    setIssuePriority: vi.fn().mockResolvedValue(undefined),
    getIssueStatuses: vi.fn().mockResolvedValue({
      issue_statuses: [{ id: 2, name: "Closed", is_closed: true }],
    }),
    getIssuePriorities: vi.fn().mockResolvedValue({
      issue_priorities: [
        { id: 2, name: "Normal" },
        { id: 3, name: "Urgent" },
      ],
    }),
    getProjectTimeEntryActivities: vi.fn().mockResolvedValue([
      { id: 9, name: "Development" },
    ]),
    getMemberships: vi.fn().mockResolvedValue([
      new Membership(11, "Alice", true),
      new Membership(42, "Team Ops", false),
    ]),
    getIssueStatusesTyped: vi.fn().mockResolvedValue([
      new TypedIssueStatus(2, "Closed"),
      new TypedIssueStatus(3, "In Progress"),
    ]),
    applyQuickUpdate: vi.fn().mockResolvedValue({
      isSuccessful: () => true,
      differences: [],
    }),
    getIssueWithJournals: vi.fn().mockResolvedValue({
      issue: { journals: [] },
    }),
    ...overrides,
  };
}

describe("IssueController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(closedIssueGuard, "confirmLogTimeOnClosedIssue").mockResolvedValue(
      true
    );
    vi.spyOn(customFieldPicker, "promptForRequiredCustomFields").mockResolvedValue(
      { values: undefined, cancelled: false, prompted: false }
    );
    vi.spyOn(datePicker, "pickOptionalDate").mockResolvedValue({
      changed: false,
      value: null,
    });
    vi.spyOn(statusBar, "showStatusBarMessage").mockImplementation(
      () => undefined
    );
  });

  it("chooseTimeEntryType stops when closed-issue confirm is declined", async () => {
    const issue = createIssue();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never);
    vi.mocked(closedIssueGuard.confirmLogTimeOnClosedIssue).mockResolvedValue(
      false
    );

    await controller.chooseTimeEntryType([{ id: 9, name: "Dev" }]);

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it("chooseTimeEntryType forwards selected activity to message flow", async () => {
    const issue = createIssue();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never);
    const activity: TimeEntryActivity = { id: 9, name: "Dev" };
    const selected = { label: "Dev", activity };
    const setTimeEntryMessageSpy = vi
      .spyOn(controller, "setTimeEntryMessage")
      .mockResolvedValue(undefined);

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
    await controller.chooseTimeEntryType([activity]);
    expect(setTimeEntryMessageSpy).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(selected as never);

    await controller.chooseTimeEntryType([activity]);

    expect(setTimeEntryMessageSpy).toHaveBeenCalledWith(selected);
  });

  it("setTimeEntryMessage logs time and refreshes tree", async () => {
    const issue = createIssue();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never);
    const activity = { label: "Dev", activity: { id: 9, name: "Dev" } };
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("1:30")
      .mockResolvedValueOnce("Refactor tests");
    vi.mocked(customFieldPicker.promptForRequiredCustomFields).mockResolvedValue(
      {
        values: [{ id: 10, value: "ABC" }],
        cancelled: false,
        prompted: true,
      }
    );

    await controller.setTimeEntryMessage(activity as never);

    const firstPrompt = vi.mocked(vscode.window.showInputBox).mock.calls[0][0] as {
      validateInput?: (value: string) => string | null;
    };
    expect(firstPrompt.validateInput?.("bad")).toContain("Must be 0.1-24 hours");

    expect(server.addTimeEntry).toHaveBeenCalledWith(
      123,
      9,
      "1.5",
      "Refactor tests",
      undefined,
      [{ id: 10, value: "ABC" }]
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "redmyne.refreshTimeEntries"
    );
    expect(statusBar.showStatusBarMessage).toHaveBeenCalledWith(
      expect.stringContaining("Logged 1:30 to #123")
    );
  });

  it("setTimeEntryMessage handles invalid and failed submissions", async () => {
    const issue = createIssue();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never);
    const activity = { label: "Dev", activity: { id: 9, name: "Dev" } };

    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("invalid");
    await controller.setTimeEntryMessage(activity as never);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Invalid time format"
    );

    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("");
    server.addTimeEntry.mockRejectedValueOnce(new Error("save failed"));
    await controller.setTimeEntryMessage(activity as never);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("save failed");
  });

  it("setTimeEntryMessage exits on cancellations and custom-field cancel", async () => {
    const issue = createIssue();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never);
    const activity = { label: "Dev", activity: { id: 9, name: "Dev" } };

    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
    await controller.setTimeEntryMessage(activity as never);
    expect(server.addTimeEntry).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce(undefined);
    await controller.setTimeEntryMessage(activity as never);
    expect(server.addTimeEntry).not.toHaveBeenCalled();

    vi.mocked(customFieldPicker.promptForRequiredCustomFields).mockImplementationOnce(
      async (getFields) => {
        await getFields();
        return { values: undefined, cancelled: true, prompted: true };
      }
    );
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("");
    await controller.setTimeEntryMessage(activity as never);
    expect(server.getTimeEntryCustomFields).toHaveBeenCalledTimes(1);
    expect(server.addTimeEntry).not.toHaveBeenCalled();
  });

  it("changeIssuePriority skips current and applies different priority", async () => {
    const issue = createIssue();
    const onIssueUpdated = vi.fn();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never, onIssueUpdated);
    const priorities: IssuePriority[] = [
      { id: 2, name: "Normal" },
      { id: 3, name: "Urgent" },
    ];

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: "Normal",
      priority: priorities[0],
    } as never);
    await controller.changeIssuePriority(priorities);
    expect(server.setIssuePriority).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: "Urgent",
      priority: priorities[1],
    } as never);
    await controller.changeIssuePriority(priorities);

    expect(server.setIssuePriority).toHaveBeenCalledWith(123, 3);
    expect(onIssueUpdated).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "redmyne.refreshAfterIssueUpdate"
    );

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: "Urgent",
      priority: priorities[1],
    } as never);
    server.setIssuePriority.mockRejectedValueOnce(new Error("priority failed"));
    await controller.changeIssuePriority(priorities);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "priority failed"
    );
  });

  it("covers private wrappers for browser/status/priority/time-entry", async () => {
    const issue = createIssue();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never);
    const runPrivate = controller as unknown as {
      openInBrowser: () => Promise<void>;
      changeStatus: () => Promise<void>;
      changePriority: () => Promise<void>;
      addTimeEntry: () => Promise<void>;
    };

    const changeIssueStatusSpy = vi
      .spyOn(controller, "changeIssueStatus")
      .mockResolvedValue(undefined);
    const changeIssuePrioritySpy = vi
      .spyOn(controller, "changeIssuePriority")
      .mockResolvedValue(undefined);
    const chooseTimeEntryTypeSpy = vi
      .spyOn(controller, "chooseTimeEntryType")
      .mockResolvedValue(undefined);

    await runPrivate.openInBrowser();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "vscode.open",
      expect.objectContaining({
        toString: expect.any(Function),
      })
    );

    vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(
      new Error("cannot open")
    );
    await runPrivate.openInBrowser();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("cannot open");

    await runPrivate.changeStatus();
    expect(server.getIssueStatuses).toHaveBeenCalledTimes(1);
    expect(changeIssueStatusSpy).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 2 })])
    );

    await runPrivate.changePriority();
    expect(server.getIssuePriorities).toHaveBeenCalledTimes(1);
    expect(changeIssuePrioritySpy).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 2 })])
    );

    await runPrivate.addTimeEntry();
    expect(server.getProjectTimeEntryActivities).toHaveBeenCalledWith(7);
    expect(chooseTimeEntryTypeSpy).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 9 })])
    );
  });

  it("quickUpdate builds payload and handles successful update", async () => {
    const issue = createIssue({ due_date: null });
    const onIssueUpdated = vi.fn();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never, onIssueUpdated);
    const runQuickUpdate = controller as unknown as { quickUpdate: () => Promise<void> };

    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({
        label: "Closed",
        status: new TypedIssueStatus(2, "Closed"),
      } as never)
      .mockResolvedValueOnce({
        label: "Team Ops (group)",
        assignee: new Membership(42, "Team Ops", false),
      } as never);
    vi.mocked(datePicker.pickOptionalDate)
      .mockResolvedValueOnce({ changed: true, value: "2026-02-15" })
      .mockResolvedValueOnce({ changed: false, value: null });
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("done");

    await runQuickUpdate.quickUpdate();

    const payload = server.applyQuickUpdate.mock.calls[0][0] as {
      issueId: number;
      message: string;
      assignee: Membership;
      status: TypedIssueStatus;
      startDate?: string | null;
      dueDate?: string | null;
    };
    expect(payload.issueId).toBe(123);
    expect(payload.message).toBe("done");
    expect(payload.assignee.id).toBe(42);
    expect(payload.status.statusId).toBe(2);
    expect(payload.startDate).toBe("2026-02-15");
    expect(payload.dueDate).toBeUndefined();
    expect(statusBar.showStatusBarMessage).toHaveBeenCalledWith(
      "$(check) Issue updated",
      2000
    );
    expect(onIssueUpdated).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "redmyne.refreshAfterIssueUpdate"
    );
  });

  it("quickUpdate reports partial and fetch failures", async () => {
    const issue = createIssue();
    const onIssueUpdated = vi.fn();
    const partial = new QuickUpdateResult();
    partial.addDifference("status mismatch");
    const server = createMockServer({
      applyQuickUpdate: vi.fn().mockResolvedValue(partial),
    });
    const controller = new IssueController(issue, server as never, onIssueUpdated);
    const runQuickUpdate = controller as unknown as { quickUpdate: () => Promise<void> };

    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({
        label: "No change",
        status: new TypedIssueStatus(1, "Open"),
      } as never)
      .mockResolvedValueOnce({
        label: "No change",
        assignee: new Membership(11, "Alice", true),
      } as never);
    vi.mocked(datePicker.pickOptionalDate)
      .mockResolvedValueOnce({ changed: false, value: "2026-02-01" })
      .mockResolvedValueOnce({ changed: true, value: null });
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("note");

    await runQuickUpdate.quickUpdate();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Issue updated partially; problems")
    );
    expect(onIssueUpdated).toHaveBeenCalledTimes(1);

    server.getMemberships.mockRejectedValueOnce(new Error("offline"));
    await runQuickUpdate.quickUpdate();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Could not fetch required data for quick update"
    );
  });

  it("quickUpdate handles cancel checkpoints and apply error", async () => {
    const issue = createIssue();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never);
    const runQuickUpdate = controller as unknown as { quickUpdate: () => Promise<void> };
    const pickStatus = { label: "Closed", status: new TypedIssueStatus(2, "Closed") };
    const pickAssignee = {
      label: "Team Ops",
      assignee: new Membership(42, "Team Ops", false),
    };

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
    await runQuickUpdate.quickUpdate();
    expect(server.applyQuickUpdate).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce(pickStatus as never)
      .mockResolvedValueOnce(undefined);
    await runQuickUpdate.quickUpdate();
    expect(server.applyQuickUpdate).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce(pickStatus as never)
      .mockResolvedValueOnce(pickAssignee as never);
    vi.mocked(datePicker.pickOptionalDate).mockResolvedValueOnce(undefined);
    await runQuickUpdate.quickUpdate();
    expect(server.applyQuickUpdate).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce(pickStatus as never)
      .mockResolvedValueOnce(pickAssignee as never);
    vi.mocked(datePicker.pickOptionalDate)
      .mockResolvedValueOnce({ changed: false, value: "2026-02-01" })
      .mockResolvedValueOnce(undefined);
    await runQuickUpdate.quickUpdate();
    expect(server.applyQuickUpdate).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce(pickStatus as never)
      .mockResolvedValueOnce(pickAssignee as never);
    vi.mocked(datePicker.pickOptionalDate)
      .mockResolvedValueOnce({ changed: false, value: "2026-02-01" })
      .mockResolvedValueOnce({ changed: false, value: "2026-02-02" });
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
    await runQuickUpdate.quickUpdate();
    expect(server.applyQuickUpdate).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce(pickStatus as never)
      .mockResolvedValueOnce(pickAssignee as never);
    vi.mocked(datePicker.pickOptionalDate)
      .mockResolvedValueOnce({ changed: false, value: "2026-02-01" })
      .mockResolvedValueOnce({ changed: false, value: "2026-02-02" });
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("note");
    server.applyQuickUpdate.mockRejectedValueOnce(new Error("apply failed"));
    await runQuickUpdate.quickUpdate();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Error while applying quick update: Error: apply failed"
    );
  });

  it("listActions routes actions and reports picker errors", async () => {
    const issue = createIssue();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never);
    const viewHistorySpy = vi
      .spyOn(controller as never, "viewHistory")
      .mockResolvedValue(undefined);

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      action: "viewHistory",
    } as never);
    await controller.listActions();
    expect(viewHistorySpy).toHaveBeenCalledTimes(1);

    vi.mocked(vscode.window.showQuickPick).mockRejectedValueOnce(
      new Error("picker failed")
    );
    await controller.listActions();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("picker failed");
  });

  it("listActions supports empty pick and each route action", async () => {
    const issue = createIssue();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never);
    const openInBrowserSpy = vi
      .spyOn(controller as never, "openInBrowser")
      .mockResolvedValue(undefined);
    const changeStatusSpy = vi
      .spyOn(controller as never, "changeStatus")
      .mockResolvedValue(undefined);
    const changePrioritySpy = vi
      .spyOn(controller as never, "changePriority")
      .mockResolvedValue(undefined);
    const addTimeEntrySpy = vi
      .spyOn(controller as never, "addTimeEntry")
      .mockResolvedValue(undefined);
    const quickUpdateSpy = vi
      .spyOn(controller as never, "quickUpdate")
      .mockResolvedValue(undefined);
    const viewHistorySpy = vi
      .spyOn(controller as never, "viewHistory")
      .mockResolvedValue(undefined);

    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ action: "openInBrowser" } as never)
      .mockResolvedValueOnce({ action: "changeStatus" } as never)
      .mockResolvedValueOnce({ action: "changePriority" } as never)
      .mockResolvedValueOnce({ action: "addTimeEntry" } as never)
      .mockResolvedValueOnce({ action: "quickUpdate" } as never)
      .mockResolvedValueOnce({ action: "viewHistory" } as never);

    await controller.listActions();
    await controller.listActions();
    await controller.listActions();
    await controller.listActions();
    await controller.listActions();
    await controller.listActions();
    await controller.listActions();

    expect(openInBrowserSpy).toHaveBeenCalledTimes(1);
    expect(changeStatusSpy).toHaveBeenCalledTimes(1);
    expect(changePrioritySpy).toHaveBeenCalledTimes(1);
    expect(addTimeEntrySpy).toHaveBeenCalledTimes(1);
    expect(quickUpdateSpy).toHaveBeenCalledTimes(1);
    expect(viewHistorySpy).toHaveBeenCalledTimes(1);
  });

  it("viewHistory handles empty, copy and back flows", async () => {
    const issue = createIssue();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never);
    const runViewHistory = controller as unknown as { viewHistory: () => Promise<void> };

    await runViewHistory.viewHistory();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "No history for #123"
    );

    const journal = {
      id: 1,
      user: { id: 99, name: "Reviewer" },
      notes: "Please adjust tests",
      created_on: "2026-02-05T10:00:00.000Z",
      private_notes: false,
      details: [
        { property: "attr" as const, name: "status_id", old_value: "1", new_value: "2" },
      ],
    };
    server.getIssueWithJournals.mockResolvedValue({
      issue: { journals: [journal] },
    });

    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ journal } as never)
      .mockResolvedValueOnce({ action: "copy" } as never);
    await runViewHistory.viewHistory();
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
      "Please adjust tests"
    );
    expect(statusBar.showStatusBarMessage).toHaveBeenCalledWith(
      "$(check) Copied to clipboard",
      2000
    );

    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ journal } as never)
      .mockResolvedValueOnce({ action: "back" } as never)
      .mockResolvedValueOnce(undefined);
    const spy = vi.spyOn(controller as never, "viewHistory");
    await runViewHistory.viewHistory();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("viewHistory handles non-attr changes and fetch errors", async () => {
    const issue = createIssue();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never);
    const runViewHistory = controller as unknown as { viewHistory: () => Promise<void> };

    server.getIssueWithJournals.mockResolvedValueOnce({
      issue: {
        journals: [
          {
            id: 2,
            user: { id: 77, name: "Bot" },
            notes: "",
            created_on: "2026-02-05T10:00:00.000Z",
            private_notes: false,
            details: [{ property: "cf", name: "Story points" }],
          },
        ],
      },
    });
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      journal: { notes: "" },
    } as never);
    await runViewHistory.viewHistory();

    server.getIssueWithJournals.mockRejectedValueOnce(new Error("history failed"));
    await runViewHistory.viewHistory();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("history failed");
  });

  it("changeIssueStatus success and failure paths", async () => {
    const issue = createIssue();
    const server = createMockServer();
    const controller = new IssueController(issue, server as never);
    const statuses: RedmineIssueStatus[] = [
      { id: 1, name: "Open", is_closed: false },
      { id: 2, name: "Closed", is_closed: true },
    ];

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
    await controller.changeIssueStatus(statuses);
    expect(server.setIssueStatus).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: "Closed",
      fullIssue: statuses[1],
    } as never);
    await controller.changeIssueStatus(statuses);
    expect(server.setIssueStatus).toHaveBeenCalledWith(issue, 2);

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: "Closed",
      fullIssue: statuses[1],
    } as never);
    server.setIssueStatus.mockRejectedValueOnce(new Error("cannot update"));
    await controller.changeIssueStatus(statuses);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("cannot update");
  });
});
