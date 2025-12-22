I have an idea that the "Core Philosophy" is "The Status Bar is King".
I need screen real estate for plots and code.
The extension should live primarily in the Sidebar (for management) and the Status Bar (for active logging), ensuring it doesn't clutter the workspace.

Redmine's web UI asks: "How is the PROJECT doing?"
This extension asks a different question: "How is MY WORKLOAD doing?"

Proposed Features:

1. The "Active Issue" Status Bar Item: A clickable item in the bottom status bar displaying: ▶ 1h 15m | #4245: Data Cleaning.
   Action: Click to Stop/Pause/Log. When logging, a modal pops up pre-filled with the elapsed time.
   Smart Defaults: It automatically fetches the "Activity" dropdown from Redmine (Design, Development) and a specific toggle for Billable / Non-Billable (mapped to Redmine custom fields).

Context-Aware Auto-Suggest:
If you open a Positron project(workspace) named BLU-808, the extension detects the workspace root folder, matches with a project, gets the issues assigned to me in that project, and asks: "Which issues would you like to start the timer for?"

"Pomodoro" Mode for Billing:
Option to set alerts every X minutes to remind you to commit your time, ensuring you don't lose track of 4 hours of work if you forget to stop the timer.

We need to avoid over-engineering and scope-creep.
The focus should be on delivering a minimal viable product that addresses the core need: tracking workload efficiently without overwhelming the user interface.

We need to be able to group the issues in the side bar by project, or priority.
Hover Actions: Hover over an issue to see the description without opening it. Right-click to "Start Timer" or "Mark as Resolved."

Can we implement a simplified Kanban view within a Positron webview panel for visual management of issues?

Smart Comments & Updates:

A standard VS Code interface to read the last 3 comments on an issue and post a quick update (e.g., "Model training started, will update in 2 hours") without opening the browser.

It would also be good to have some sort of notification to alert the user when an issue is approaching its due date or when there are new comments added or updates to an issue they are tracking.

In the gantt chart, perhaps a Burndown visualization: "You have 15 hours of estimated work assigned due by Friday, but only 12 work hours remaining."

Dependency Watcher:

If you are blocked by another issue (Redmine "blocked by" relationship), that issue appears in your sidebar with a "Locked" icon.

Notification: When the blocking issue is closed by your colleague, you get a toast notification in Positron: "Issue #101 is closed. You can now start #102."

"Copy Status for MS Teams":

A command palette action (Ctrl+Shift+P -> Redmine: Copy Status Report).

It generates a clipboard snippet to paste into Teams:

"Current Status: Working on #4245 (ETA: 2h). Queue: #4246 (Due tomorrow), #4290. Next availability: Thursday 2 PM."

Summary of the UX Flow
Start of Day: You open Positron. The Sidebar shows your "Due Today" list.

Start Work: You click the "Play" button on Issue #500. The Status Bar turns green.

Interruption: A Teams message asks for an ETA. You run > Redmine: Check Capacity and see you are booked until Wednesday. You reply.

Context Switch: You need to switch to a different project. You click the Status Bar, log the time (marked Billable), and select the new issue from the dropdown.

End of Day: You review the "Time Logged Today" summary in the sidebar to ensure you hit your billable targets before closing Positron.

Feature: "Smart Commit" Preparation

User Action: You finish a task in the Redmine Sidebar and click a "Prepare Commit" button (or right-click the active status bar timer).

System Action:

The Redmine extension formats a string: refs #4245 @1.5h - Fixed data ingestion bug.

It executes a VS Code command targeting your SVN extension (e.g., positron-svn.setCommitMessage).

Your positron-svn SCM input box pre-fills with that text.

Redmine Magic: Redmine automatically parses refs #ID to link the revision and @1.5h to log time (if your Redmine instance has the time-logging commit hook enabled). If not, the extension logs the time via API, and the commit message just handles the linking.

3. The "Colleague's Commit" Watcher
   Solving the "How do tasks assigned to others feed back into my work" problem.

In a "No Branching" SVN environment, breaking changes happen on trunk. You need to know when a colleague has committed a fix so you can svn update.

Feature: Dependency Alerts

The Scenario: You are waiting on a colleague to finish Issue #555 ("Fix Database View").

The Watcher: The extension polls Redmine. When Issue #555 is marked "Resolved" or "Closed," it checks if a Revision Number (e.g., r10203) is associated with that ticket.

The Notification: You get a toast in Positron: "Issue #555 Closed in r10203. Run SVN Update?"

Action: Clicking "Yes" triggers positron-svn to update your working copy.

4. Billing & Capacity Dashboard (The Consultant View)
   Solving the "Timeline" and "Invoicing" problem.

Since you handle multiple projects, you need a high-level view of your "Billable Inventory."

Feature: The "Billable vs. Non-Billable" Toggle

Strict Mode: If you select an issue from a project marked "Client Billable," the timer defaults to "Billable." If you switch to an internal admin task, it auto-switches to "Non-Billable."

Day View: A simple bar chart in the sidebar showing:

Target: 6.0 Billable Hours.

Actual: 4.5 Hours logged so far.

Gap: 1.5 Hours remaining (Visual motivation to finish the day's logs).
