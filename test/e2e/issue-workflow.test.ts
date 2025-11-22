import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import * as http from "http";
import * as vscode from "vscode";
import { RedmineServer } from "../../src/redmine/redmine-server";
import { IssueController } from "../../src/controllers/issue-controller";
import listOpenIssuesAssignedToMe from "../../src/commands/list-open-issues-assigned-to-me";
import { Membership, IssueStatus } from "../../src/controllers/domain";

vi.mock("vscode");

let mockHttpResponses: unknown[] = [];
let mockHttpResponseIndex = 0;

vi.mock("http", async () => {
  const actual = await vi.importActual<typeof http>("http");
  return {
    ...actual,
    request: vi.fn((options, callback) => {
      const request = new EventEmitter() as http.ClientRequest;

      type MockRequest = http.ClientRequest & {
        end: (data?: Buffer) => http.ClientRequest;
        write: () => boolean;
        abort: () => void;
      };

      (request as MockRequest).end = function (this: http.ClientRequest, _data?: Buffer) {
        const response = new EventEmitter() as http.IncomingMessage;
        response.statusCode = 200;
        response.statusMessage = "OK";

        setTimeout(() => {
          const responseData = mockHttpResponses[mockHttpResponseIndex] || null;
          mockHttpResponseIndex++;

          if (responseData) {
            response.emit("data", Buffer.from(JSON.stringify(responseData)));
          }
          response.emit("end");
        }, 0);

        if (callback) {
          callback(response);
        }
        return this;
      };

      (request as MockRequest).write = vi.fn().mockReturnValue(true);
      (request as MockRequest).abort = vi.fn();

      return request;
    }),
  };
});

describe("Issue Workflow E2E", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHttpResponses = [];
    mockHttpResponseIndex = 0;
    vi.mocked(vscode.window.withProgress).mockImplementation(
      async (_options, callback) => callback({ report: vi.fn() } as vscode.Progress<{ message?: string; increment?: number }>)
    );
  });

  it("full list issues workflow with change status", async () => {
    const mockIssue = {
      id: 123,
      subject: "Test Issue",
      status: { id: 1, name: "New" },
      tracker: { id: 1, name: "Bug" },
      author: { id: 1, name: "Author" },
      project: { id: 1, name: "Project" },
      assigned_to: { id: 1, name: "User" },
      description: "Test description",
    };

    // Setup HTTP responses: 1) getIssuesAssignedToMe, 2) getIssueStatuses, 3) setIssueStatus
    mockHttpResponses = [
      { issues: [mockIssue] },
      { issue_statuses: [{ id: 2, name: "Resolved" }] },
      {},
    ];

    const server = new RedmineServer({
      address: "http://localhost:3000",
      key: "testkey",
    });

    // Mock user selecting first issue
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({
        label: "[Bug] (New) Test Issue by Author",
        description: "Test description",
        detail: "Issue #123 assigned to User",
        fullIssue: mockIssue,
      } as vscode.QuickPickItem & { fullIssue: typeof mockIssue })
      // Mock selecting "Change status" action
      .mockResolvedValueOnce({
        action: "changeStatus",
        label: "Change status",
      } as vscode.QuickPickItem & { action: string })
      // Mock selecting new status
      .mockResolvedValueOnce({
        label: "Resolved",
        fullIssue: { id: 2, name: "Resolved" },
      } as vscode.QuickPickItem & { fullIssue: { id: number; name: string } });

    await listOpenIssuesAssignedToMe({ server, config: {} });

    // Wait for async promise chains to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(3);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Issue #123 status changed to Resolved"
    );
  });

  it("add time entry workflow", async () => {
    const mockIssue = {
      id: 456,
      subject: "Time Entry Test",
      status: { id: 1, name: "In Progress" },
      tracker: { id: 1, name: "Feature" },
      author: { id: 1, name: "Author" },
      project: { id: 1, name: "Project" },
      assigned_to: { id: 1, name: "User" },
    };

    const mockActivity = { id: 9, name: "Development" };

    // Setup HTTP responses: 1) getTimeEntryActivities, 2) addTimeEntry
    mockHttpResponses = [
      { time_entry_activities: [mockActivity] },
      { time_entry: { id: 1 } },
    ];

    const server = new RedmineServer({
      address: "http://localhost:3000",
      key: "testkey",
    });

    const controller = new IssueController(mockIssue as Parameters<typeof IssueController>[0], server);

    // Mock activity selection
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: "Development",
      activity: mockActivity,
    } as vscode.QuickPickItem & { activity: typeof mockActivity });

    // Mock hours|message input
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("2.5|Fixed bug");

    const activities = await server.getTimeEntryActivities();
    controller.chooseTimeEntryType(activities.time_entry_activities);

    // Wait for async promise chains to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Time entry for issue #456 has been added."
    );
  });

  it("quick update workflow", async () => {
    const mockIssue = {
      id: 789,
      subject: "Quick Update Test",
      status: { id: 1, name: "New" },
      tracker: { id: 1, name: "Bug" },
      author: { id: 1, name: "Author" },
      project: { id: 1, name: "Project" },
      assigned_to: { id: 1, name: "User" },
    };

    // Setup HTTP responses: 1) applyQuickUpdate PUT, 2) getIssueById GET
    mockHttpResponses = [
      {}, // PUT /issues/789.json response
      {
        issue: {
          ...mockIssue,
          assigned_to: { id: 2, name: "NewUser" },
          status: { id: 3, name: "Resolved" },
        },
      }, // GET /issues/789.json response
    ];

    const server = new RedmineServer({
      address: "http://localhost:3000",
      key: "testkey",
    });

    const quickUpdate = {
      issueId: 789,
      message: "Fixed and reassigned",
      assignee: new Membership(2, "NewUser"),
      status: new IssueStatus(3, "Resolved"),
    };

    const result = await server.applyQuickUpdate(quickUpdate);

    expect(result.isSuccessful()).toBe(true);
    expect(result.differences).toHaveLength(0);
  });
});
