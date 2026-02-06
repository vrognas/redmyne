/**
 * Create Test Issues Command
 * Dev/test command for creating sample issues
 */

import * as vscode from "vscode";
import { RedmineServer } from "../redmine/redmine-server";
import { formatDateISO } from "../utilities/date-utils";
import { getServerOrShowError } from "./command-guards";

export interface CreateTestIssuesDeps {
  getServer: () => RedmineServer | undefined;
  refreshProjects: () => void;
}

export function registerCreateTestIssuesCommand(
  context: vscode.ExtensionContext,
  deps: CreateTestIssuesDeps
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("redmyne.createTestIssues", async () => {
      const server = getServerOrShowError(
        deps.getServer,
        "Redmine not configured. Run 'Redmine: Configure' first."
      );
      if (!server) return;

      const confirm = await vscode.window.showWarningMessage(
        "Create test issues for integration testing?",
        { modal: true, detail: "This will create 10 test issues in the Operations project." },
        "Create Issues"
      );
      if (confirm !== "Create Issues") return;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Creating test issues",
        cancellable: false
      }, async (progress) => {
        try {
          progress.report({ message: "Fetching metadata..." });
          const [projects, trackers, statuses, priorities] = await Promise.all([
            server.getProjects(),
            server.getTrackers(),
            server.getIssueStatuses(),
            server.getPriorities()
          ]);

          const operationsProject = projects.find(p => {
            const pick = p.toQuickPickItem();
            return pick.label === "Operations" || pick.identifier === "operations";
          });
          if (!operationsProject) {
            vscode.window.showErrorMessage(
              `Operations project not found. Available: ${projects.map(p => p.toQuickPickItem().label).join(", ")}`
            );
            return;
          }

          const taskTracker = trackers.find(t => t.name.toLowerCase().includes("task"));
          const inProgressStatus = statuses.issue_statuses.find(s => s.name.toLowerCase().includes("progress"));
          const newStatus = statuses.issue_statuses.find(s =>
            s.name.toLowerCase() === "new" || s.name.toLowerCase().includes("not yet")
          );
          const normalPriority = priorities.find(p => p.name.toLowerCase() === "normal");
          const highPriority = priorities.find(p => p.name.toLowerCase() === "high");
          const urgentPriority = priorities.find(p => p.name.toLowerCase() === "urgent");
          const lowPriority = priorities.find(p => p.name.toLowerCase() === "low");

          if (!taskTracker) {
            vscode.window.showErrorMessage("Task tracker not found");
            return;
          }

          const addDays = (date: string, days: number) => {
            const d = new Date(date);
            d.setDate(d.getDate() + days);
            return formatDateISO(d);
          };
          const nextFriday = () => {
            const d = new Date();
            const day = d.getDay();
            const daysUntilFriday = (5 - day + 7) % 7 || 7;
            d.setDate(d.getDate() + daysUntilFriday);
            return formatDateISO(d);
          };

          const TEST_PREFIX = "[TEST]";
          const todayStr = formatDateISO(new Date());

          const testIssues = [
            {
              subject: `${TEST_PREFIX} High intensity task`,
              start_date: todayStr,
              due_date: addDays(todayStr, 2),
              estimated_hours: 24,
              status_id: inProgressStatus?.id,
              priority_id: highPriority?.id,
              description: "Test issue: 24h over 3 days = 100% intensity (8h/day)",
            },
            {
              subject: `${TEST_PREFIX} Low intensity task`,
              start_date: todayStr,
              due_date: addDays(todayStr, 9),
              estimated_hours: 8,
              status_id: newStatus?.id,
              priority_id: normalPriority?.id,
              description: "Test issue: 8h over 10 days = ~10% intensity",
            },
            {
              subject: `${TEST_PREFIX} Overbooked urgent`,
              start_date: todayStr,
              due_date: addDays(todayStr, 1),
              estimated_hours: 24,
              status_id: inProgressStatus?.id,
              priority_id: urgentPriority?.id,
              description: "Test issue: 24h over 2 days = 150% intensity (overbooked)",
            },
            {
              subject: `${TEST_PREFIX} No estimate task`,
              start_date: todayStr,
              due_date: addDays(todayStr, 5),
              estimated_hours: undefined,
              status_id: newStatus?.id,
              priority_id: lowPriority?.id,
              description: "Test issue: No estimated hours - should show 0 intensity",
            },
            {
              subject: `${TEST_PREFIX} Weekend spanning`,
              start_date: nextFriday(),
              due_date: addDays(nextFriday(), 4),
              estimated_hours: 16,
              status_id: inProgressStatus?.id,
              priority_id: normalPriority?.id,
              description: "Test issue: Spans weekend - tests weeklySchedule (0h Sat/Sun)",
            },
            {
              subject: `${TEST_PREFIX} Parent task`,
              start_date: todayStr,
              due_date: addDays(todayStr, 14),
              estimated_hours: 40,
              status_id: newStatus?.id,
              priority_id: highPriority?.id,
              description: "Test issue: Parent task with children",
              isParent: true,
            },
            {
              subject: `${TEST_PREFIX} Child task A`,
              start_date: todayStr,
              due_date: addDays(todayStr, 6),
              estimated_hours: 16,
              status_id: inProgressStatus?.id,
              priority_id: normalPriority?.id,
              description: "Test issue: Child of parent task",
              parentSubject: `${TEST_PREFIX} Parent task`,
            },
            {
              subject: `${TEST_PREFIX} Child task B`,
              start_date: addDays(todayStr, 7),
              due_date: addDays(todayStr, 14),
              estimated_hours: 24,
              status_id: newStatus?.id,
              priority_id: normalPriority?.id,
              description: "Test issue: Child of parent task",
              parentSubject: `${TEST_PREFIX} Parent task`,
            },
            {
              subject: `${TEST_PREFIX} Blocking task`,
              start_date: todayStr,
              due_date: addDays(todayStr, 3),
              estimated_hours: 8,
              status_id: inProgressStatus?.id,
              priority_id: highPriority?.id,
              description: "Test issue: Blocks another task",
              blocksSubject: `${TEST_PREFIX} Blocked task`,
            },
            {
              subject: `${TEST_PREFIX} Blocked task`,
              start_date: addDays(todayStr, 4),
              due_date: addDays(todayStr, 7),
              estimated_hours: 16,
              status_id: newStatus?.id,
              priority_id: normalPriority?.id,
              description: "Test issue: Blocked by another task",
            },
          ];

          const createdIssues = new Map<string, number>();
          let created = 0;
          let failed = 0;

          for (let i = 0; i < testIssues.length; i++) {
            const issue = testIssues[i];
            progress.report({
              message: `Creating ${i + 1}/${testIssues.length}: ${issue.subject}`,
              increment: 100 / testIssues.length
            });

            let parent_issue_id: number | undefined;
            if ("parentSubject" in issue && issue.parentSubject) {
              parent_issue_id = createdIssues.get(issue.parentSubject);
            }

            try {
              const result = await server.createIssue({
                project_id: operationsProject.id,
                tracker_id: taskTracker.id,
                subject: issue.subject,
                description: issue.description,
                status_id: issue.status_id,
                priority_id: issue.priority_id,
                start_date: issue.start_date,
                due_date: issue.due_date,
                estimated_hours: issue.estimated_hours,
                parent_issue_id,
              });
              createdIssues.set(issue.subject, result.issue.id);
              created++;
            } catch (_e) {
              failed++;
            }
          }

          // Create blocking relation
          const blockingId = createdIssues.get(`${TEST_PREFIX} Blocking task`);
          const blockedId = createdIssues.get(`${TEST_PREFIX} Blocked task`);
          if (blockingId && blockedId) {
            try {
              await server.createRelation(blockingId, blockedId, "blocks");
            } catch {
              // Relation creation failed - non-critical
            }
          }

          deps.refreshProjects();

          vscode.window.showInformationMessage(
            `Created ${created} test issues${failed > 0 ? `, ${failed} failed` : ""}`
          );
        } catch (e) {
          vscode.window.showErrorMessage(`Failed to create test issues: ${e}`);
        }
      });
    })
  );
}
