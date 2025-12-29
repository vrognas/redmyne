import { describe, it, expect, beforeEach } from "vitest";
import { RedmineServer } from "../../src/redmine/redmine-server";
import {
  createMockState,
  createStatefulMockRequest,
  MockRedmineState,
} from "./mocks/redmine-api-mock";

/**
 * Integration Tests: Redmine API Workflow
 *
 * Tests multi-step workflows with stateful mock verifying cross-call consistency.
 * Unit tests cover individual methods; these test realistic user scenarios.
 */
describe("Integration: Redmine API Workflow", () => {
  let server: RedmineServer;
  let state: MockRedmineState;

  beforeEach(() => {
    state = createMockState();
    server = new RedmineServer({
      address: "https://redmine.example.com",
      key: "test-api-key",
      requestFn: createStatefulMockRequest(state),
    });
  });

  it("issue lifecycle: create → update status → log time → verify cumulative hours", async () => {
    // Create issue
    const { issue } = await server.createIssue({
      project_id: 1,
      tracker_id: 3,
      subject: "Implement feature",
      estimated_hours: 8,
    });
    expect(issue.spent_hours).toBe(0);

    // Update status
    await server.setIssueStatus(issue, 2);
    const afterStatus = await server.getIssueById(issue.id);
    expect(afterStatus.issue.status.id).toBe(2);

    // Log time entries - verify cumulative
    await server.addTimeEntry(issue.id, 9, "2.5", "Initial work");
    await server.addTimeEntry(issue.id, 9, "1.5", "Continued");

    const final = await server.getIssueById(issue.id);
    expect(final.issue.spent_hours).toBe(4.0);
  });

  it("multi-issue time tracking: separate spent_hours per issue", async () => {
    const issue1 = await server.createIssue({ project_id: 1, tracker_id: 1, subject: "Bug" });
    const issue2 = await server.createIssue({ project_id: 1, tracker_id: 2, subject: "Feature" });

    await server.addTimeEntry(issue1.issue.id, 9, "2.0", "Bug fix");
    await server.addTimeEntry(issue2.issue.id, 9, "4.0", "Feature dev");
    await server.addTimeEntry(issue1.issue.id, 10, "1.0", "Testing");

    const after1 = await server.getIssueById(issue1.issue.id);
    const after2 = await server.getIssueById(issue2.issue.id);

    expect(after1.issue.spent_hours).toBe(3.0);
    expect(after2.issue.spent_hours).toBe(4.0);
  });

  it("time entry lifecycle: create → update → delete → verify removal", async () => {
    const { issue } = await server.createIssue({ project_id: 1, tracker_id: 3, subject: "Test" });

    const { time_entry } = await server.addTimeEntry(issue.id, 9, "4.0", "Initial");
    await server.updateTimeEntry(time_entry.id, { hours: "5.0", comments: "Updated" });

    const entries = await server.getTimeEntries();
    expect(entries.time_entries.find(e => e.id === time_entry.id)?.hours).toBe("5.0");

    await server.deleteTimeEntry(time_entry.id);
    const afterDelete = await server.getTimeEntries();
    expect(afterDelete.time_entries.find(e => e.id === time_entry.id)).toBeUndefined();
  });
});
