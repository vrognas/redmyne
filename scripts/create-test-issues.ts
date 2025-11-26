#!/usr/bin/env npx tsx
/**
 * Script to create test issues for integration testing
 *
 * Usage:
 *   REDMINE_URL=https://your-redmine.com REDMINE_API_KEY=your-key npx tsx scripts/create-test-issues.ts
 *
 * Or with arguments:
 *   npx tsx scripts/create-test-issues.ts --url https://your-redmine.com --key your-key
 *
 * For self-signed/corporate certificates, add --insecure flag
 */

const REDMINE_URL = process.env.REDMINE_URL || process.argv.find((_, i, a) => a[i - 1] === "--url");
const REDMINE_API_KEY = process.env.REDMINE_API_KEY || process.argv.find((_, i, a) => a[i - 1] === "--key");
const DRY_RUN = process.argv.includes("--dry-run");
const INSECURE = process.argv.includes("--insecure");

// Handle self-signed certificates if --insecure flag is used
if (INSECURE) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.log("WARNING: SSL certificate verification disabled (--insecure)\n");
}

if (!REDMINE_URL || !REDMINE_API_KEY) {
  console.error("Error: REDMINE_URL and REDMINE_API_KEY are required");
  console.error("Usage: REDMINE_URL=... REDMINE_API_KEY=... npx tsx scripts/create-test-issues.ts");
  console.error("   or: npx tsx scripts/create-test-issues.ts --url URL --key KEY [--dry-run]");
  process.exit(1);
}

// Test issue prefix for identification
const TEST_PREFIX = "[TEST]";

interface RedmineProject {
  id: number;
  name: string;
  identifier: string;
}

interface RedmineIssue {
  id: number;
  subject: string;
  project: { id: number; name: string };
  status: { id: number; name: string };
  priority: { id: number; name: string };
  start_date?: string;
  due_date?: string;
  estimated_hours?: number;
  parent?: { id: number };
}

interface RedmineCustomField {
  id: number;
  name: string;
  customized_type: string;
  field_format: string;
  possible_values?: { value: string; label?: string }[];
}

interface RedmineTracker {
  id: number;
  name: string;
}

interface RedminePriority {
  id: number;
  name: string;
}

interface RedmineStatus {
  id: number;
  name: string;
}

// API helpers
async function redmineGet<T>(path: string): Promise<T> {
  const url = `${REDMINE_URL}${path}`;
  const response = await fetch(url, {
    headers: {
      "X-Redmine-API-Key": REDMINE_API_KEY!,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function redminePost<T>(path: string, body: unknown): Promise<T> {
  const url = `${REDMINE_URL}${path}`;
  console.log(`POST ${path}`, JSON.stringify(body, null, 2));

  if (DRY_RUN) {
    console.log("  [DRY RUN - skipping]");
    return {} as T;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Redmine-API-Key": REDMINE_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`POST ${path} failed: ${response.status} ${response.statusText}\n${text}`);
  }
  return response.json();
}

// Date helpers
function today(): string {
  return new Date().toISOString().split("T")[0];
}

function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function nextFriday(): string {
  const d = new Date();
  const day = d.getDay();
  const daysUntilFriday = (5 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilFriday);
  return d.toISOString().split("T")[0];
}

async function main() {
  console.log("=== Redmine Test Issue Creator ===\n");
  console.log(`URL: ${REDMINE_URL}`);
  console.log(`Dry run: ${DRY_RUN}\n`);

  // 1. Get projects and find "Operations"
  console.log("Fetching projects...");
  const { projects } = await redmineGet<{ projects: RedmineProject[] }>("/projects.json?limit=100");
  const operationsProject = projects.find(p => p.name === "Operations" || p.identifier === "operations");

  if (!operationsProject) {
    console.error("Could not find 'Operations' project. Available projects:");
    projects.forEach(p => console.log(`  - ${p.name} (${p.identifier})`));
    process.exit(1);
  }
  console.log(`Found project: ${operationsProject.name} (id: ${operationsProject.id})\n`);

  // 2. Get trackers, statuses, priorities
  console.log("Fetching trackers, statuses, priorities...");
  const [{ trackers }, { issue_statuses }, { issue_priorities }] = await Promise.all([
    redmineGet<{ trackers: RedmineTracker[] }>("/trackers.json"),
    redmineGet<{ issue_statuses: RedmineStatus[] }>("/issue_statuses.json"),
    redmineGet<{ issue_priorities: RedminePriority[] }>("/enumerations/issue_priorities.json"),
  ]);

  console.log("Trackers:", trackers.map(t => `${t.name}(${t.id})`).join(", "));
  console.log("Statuses:", issue_statuses.map(s => `${s.name}(${s.id})`).join(", "));
  console.log("Priorities:", issue_priorities.map(p => `${p.name}(${p.id})`).join(", "));

  // Find IDs
  const taskTracker = trackers.find(t => t.name.toLowerCase().includes("task"));
  const inProgressStatus = issue_statuses.find(s => s.name.toLowerCase().includes("progress"));
  const newStatus = issue_statuses.find(s => s.name.toLowerCase() === "new" || s.name.toLowerCase().includes("not yet"));
  const closedStatus = issue_statuses.find(s => s.name.toLowerCase() === "closed");
  const normalPriority = issue_priorities.find(p => p.name.toLowerCase() === "normal");
  const highPriority = issue_priorities.find(p => p.name.toLowerCase() === "high");
  const urgentPriority = issue_priorities.find(p => p.name.toLowerCase() === "urgent");
  const lowPriority = issue_priorities.find(p => p.name.toLowerCase() === "low");

  if (!taskTracker) {
    console.error("Could not find 'Task' tracker");
    process.exit(1);
  }

  // 3. Get custom fields
  console.log("\nFetching custom fields...");
  let customFields: RedmineCustomField[] = [];
  try {
    const cf = await redmineGet<{ custom_fields: RedmineCustomField[] }>("/custom_fields.json");
    customFields = cf.custom_fields.filter(f => f.customized_type === "issue");
    console.log("Issue custom fields:");
    customFields.forEach(f => {
      const values = f.possible_values?.map(v => v.value || v.label).join(", ") || "";
      console.log(`  - ${f.name} (id:${f.id}, format:${f.field_format})${values ? ` [${values}]` : ""}`);
    });
  } catch (e) {
    console.log("Could not fetch custom fields (may require admin). Continuing without them...");
  }

  // Map custom field names to IDs
  const cfMap = new Map(customFields.map(f => [f.name.toLowerCase(), f]));
  const getCustomFieldValue = (name: string, value: string) => {
    const field = cfMap.get(name.toLowerCase());
    return field ? { id: field.id, value } : null;
  };

  // 4. Check for existing test issues
  console.log("\nChecking for existing test issues...");
  const { issues: existingIssues } = await redmineGet<{ issues: RedmineIssue[] }>(
    `/issues.json?project_id=${operationsProject.id}&subject=~${encodeURIComponent(TEST_PREFIX)}&limit=100`
  );

  const existingSubjects = new Set(existingIssues.map(i => i.subject));
  console.log(`Found ${existingIssues.length} existing test issues`);
  existingIssues.forEach(i => console.log(`  - #${i.id}: ${i.subject}`));

  // 5. Define test issues
  const todayStr = today();

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
      estimated_hours: undefined, // No estimate
      status_id: newStatus?.id,
      priority_id: lowPriority?.id,
      description: "Test issue: No estimated hours - should show 0 intensity",
    },
    {
      subject: `${TEST_PREFIX} Weekend spanning`,
      start_date: nextFriday(),
      due_date: addDays(nextFriday(), 4), // Fri to Tue
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

  // 6. Create issues
  console.log("\n=== Creating test issues ===\n");
  const createdIssues = new Map<string, number>();

  for (const issue of testIssues) {
    if (existingSubjects.has(issue.subject)) {
      console.log(`SKIP: "${issue.subject}" already exists`);
      // Store ID for parent/relation linking
      const existing = existingIssues.find(i => i.subject === issue.subject);
      if (existing) createdIssues.set(issue.subject, existing.id);
      continue;
    }

    // Build custom fields array
    const custom_fields: { id: number; value: string }[] = [];
    const addCf = (name: string, value: string) => {
      const cf = getCustomFieldValue(name, value);
      if (cf) custom_fields.push(cf);
    };

    // Add custom fields based on your Redmine setup
    addCf("Business Area", "Software Development");
    addCf("Budget", "1000");
    addCf("Fixed Price", "No");
    addCf("Daily Rate", "100");
    addCf("Currency", "EUR");
    addCf("First time task", "No");

    // Find parent ID if needed
    let parent_issue_id: number | undefined;
    if ("parentSubject" in issue && issue.parentSubject) {
      parent_issue_id = createdIssues.get(issue.parentSubject);
      if (!parent_issue_id) {
        console.log(`WARN: Parent "${issue.parentSubject}" not found yet, skipping parent link`);
      }
    }

    const payload = {
      issue: {
        project_id: operationsProject.id,
        tracker_id: taskTracker.id,
        subject: issue.subject,
        description: issue.description,
        status_id: issue.status_id || newStatus?.id,
        priority_id: issue.priority_id || normalPriority?.id,
        start_date: issue.start_date,
        due_date: issue.due_date,
        estimated_hours: issue.estimated_hours,
        parent_issue_id,
        custom_fields: custom_fields.length > 0 ? custom_fields : undefined,
      },
    };

    try {
      const result = await redminePost<{ issue: RedmineIssue }>("/issues.json", payload);
      const newId = result.issue?.id || 0;
      createdIssues.set(issue.subject, newId);
      console.log(`CREATED: #${newId} "${issue.subject}"`);
    } catch (e) {
      console.error(`FAILED: "${issue.subject}" - ${e}`);
    }
  }

  // 7. Create blocking relation
  console.log("\n=== Creating relations ===\n");
  const blockingId = createdIssues.get(`${TEST_PREFIX} Blocking task`);
  const blockedId = createdIssues.get(`${TEST_PREFIX} Blocked task`);

  if (blockingId && blockedId) {
    try {
      await redminePost(`/issues/${blockingId}/relations.json`, {
        relation: {
          issue_to_id: blockedId,
          relation_type: "blocks",
        },
      });
      console.log(`CREATED: #${blockingId} blocks #${blockedId}`);
    } catch (e) {
      console.log(`SKIP/FAILED: Relation may already exist - ${e}`);
    }
  }

  console.log("\n=== Done ===");
  console.log(`Created ${createdIssues.size} issues in project "${operationsProject.name}"`);
}

main().catch(console.error);
