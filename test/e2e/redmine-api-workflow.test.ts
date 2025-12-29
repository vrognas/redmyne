import { describe, it, expect, beforeEach } from "vitest";
import { RedmineServer } from "../../src/redmine/redmine-server";
import {
  createMockState,
  createStatefulMockRequest,
  MockRedmineState,
} from "./mocks/redmine-api-mock";

/**
 * E2E Integration Tests: Redmine API Workflow
 *
 * Tests complete workflows through RedmineServer with stateful mock.
 * Verifies data consistency across multiple API calls.
 */
describe("E2E: Redmine API Workflow", () => {
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

  describe("Issue Lifecycle", () => {
    it("should complete full issue lifecycle: create → update status → log time → verify", async () => {
      // 1. Create issue
      const createResult = await server.createIssue({
        project_id: 1,
        tracker_id: 3,
        subject: "Implement new feature",
        description: "Detailed description here",
        priority_id: 2,
        estimated_hours: 8,
      });

      expect(createResult.issue.id).toBeGreaterThan(0);
      expect(createResult.issue.subject).toBe("Implement new feature");
      expect(createResult.issue.status.name).toBe("New");
      expect(createResult.issue.done_ratio).toBe(0);
      expect(createResult.issue.spent_hours).toBe(0);

      const issueId = createResult.issue.id;

      // 2. Update status to "In Progress"
      await server.setIssueStatus(createResult.issue, 2);

      // 3. Verify status updated
      const afterStatus = await server.getIssueById(issueId);
      expect(afterStatus.issue.status.id).toBe(2);
      expect(afterStatus.issue.status.name).toBe("In Progress");

      // 4. Log time entry
      await server.addTimeEntry(issueId, 9, "2.5", "Initial development");

      // 5. Verify spent_hours updated
      const afterTime = await server.getIssueById(issueId);
      expect(afterTime.issue.spent_hours).toBe(2.5);

      // 6. Log more time
      await server.addTimeEntry(issueId, 9, "1.5", "Continued work");

      // 7. Verify cumulative spent_hours
      const afterMoreTime = await server.getIssueById(issueId);
      expect(afterMoreTime.issue.spent_hours).toBe(4);
    });

    it("should handle issue update with dates", async () => {
      // Create issue
      const { issue } = await server.createIssue({
        project_id: 1,
        tracker_id: 2,
        subject: "Feature with dates",
        start_date: "2025-01-15",
        due_date: "2025-01-31",
      });

      expect(issue.start_date).toBe("2025-01-15");
      expect(issue.due_date).toBe("2025-01-31");

      // Update dates
      await server.updateIssueDates(issue.id, "2025-02-01", "2025-02-15");

      // Verify
      const updated = await server.getIssueById(issue.id);
      expect(updated.issue.start_date).toBe("2025-02-01");
      expect(updated.issue.due_date).toBe("2025-02-15");
    });

    it("should update done_ratio correctly", async () => {
      // Create issue
      const { issue } = await server.createIssue({
        project_id: 1,
        tracker_id: 3,
        subject: "Task with progress",
      });

      expect(issue.done_ratio).toBe(0);

      // Update progress
      await server.updateDoneRatio(issue.id, 50);

      const after50 = await server.getIssueById(issue.id);
      expect(after50.issue.done_ratio).toBe(50);

      // Complete
      await server.updateDoneRatio(issue.id, 100);

      const after100 = await server.getIssueById(issue.id);
      expect(after100.issue.done_ratio).toBe(100);
    });
  });

  describe("Time Entry CRUD", () => {
    it("should complete time entry lifecycle: create → update → delete", async () => {
      // First create an issue
      const { issue } = await server.createIssue({
        project_id: 1,
        tracker_id: 3,
        subject: "Time tracking test",
      });

      // Create time entry
      const createResult = await server.addTimeEntry(
        issue.id,
        9,
        "4.0",
        "Initial entry"
      );
      expect(createResult.time_entry.id).toBeGreaterThan(0);
      expect(createResult.time_entry.hours).toBe("4.0");

      const entryId = createResult.time_entry.id;

      // Update time entry
      await server.updateTimeEntry(entryId, {
        hours: "5.0",
        comments: "Updated comment",
      });

      // Verify via getTimeEntries
      const entries = await server.getTimeEntries();
      const updated = entries.time_entries.find((e) => e.id === entryId);
      expect(updated?.hours).toBe("5.0");
      expect(updated?.comments).toBe("Updated comment");

      // Delete time entry
      await server.deleteTimeEntry(entryId);

      // Verify deleted
      const afterDelete = await server.getTimeEntries();
      expect(afterDelete.time_entries.find((e) => e.id === entryId)).toBeUndefined();
    });

    it("should handle time entries for specific date", async () => {
      const { issue } = await server.createIssue({
        project_id: 1,
        tracker_id: 3,
        subject: "Past date entry",
      });

      // Log time for a specific past date
      const pastDate = "2025-01-10";
      const result = await server.addTimeEntry(
        issue.id,
        9,
        "2.0",
        "Retroactive entry",
        pastDate
      );

      expect(result.time_entry.spent_on).toBe(pastDate);
    });
  });

  describe("Multi-Entity Workflows", () => {
    it("should handle multiple issues and track time separately", async () => {
      // Create two issues
      const issue1 = await server.createIssue({
        project_id: 1,
        tracker_id: 1,
        subject: "Bug fix #1",
      });
      const issue2 = await server.createIssue({
        project_id: 1,
        tracker_id: 2,
        subject: "Feature #2",
      });

      // Log time to each
      await server.addTimeEntry(issue1.issue.id, 9, "2.0", "Bug investigation");
      await server.addTimeEntry(issue2.issue.id, 9, "4.0", "Feature dev");
      await server.addTimeEntry(issue1.issue.id, 10, "1.0", "Bug testing");

      // Verify separate spent_hours
      const after1 = await server.getIssueById(issue1.issue.id);
      const after2 = await server.getIssueById(issue2.issue.id);

      expect(after1.issue.spent_hours).toBe(3.0); // 2.0 + 1.0
      expect(after2.issue.spent_hours).toBe(4.0);

      // Verify total time entries
      const allEntries = await server.getTimeEntries();
      expect(allEntries.time_entries).toHaveLength(3);
    });

    it("should list issues after creation", async () => {
      // Create issues
      await server.createIssue({ project_id: 1, tracker_id: 1, subject: "Issue A" });
      await server.createIssue({ project_id: 1, tracker_id: 2, subject: "Issue B" });
      await server.createIssue({ project_id: 2, tracker_id: 3, subject: "Issue C" });

      // List all issues
      const result = await server.getFilteredIssues({
        assignee: "any",
        status: "open",
      });

      expect(result.issues).toHaveLength(3);
      expect(result.issues.map((i) => i.subject)).toEqual(
        expect.arrayContaining(["Issue A", "Issue B", "Issue C"])
      );
    });
  });
});
