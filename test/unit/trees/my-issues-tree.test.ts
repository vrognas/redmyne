import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  MyIssuesTree,
  isParentContainer,
  ParentContainer,
} from "../../../src/trees/my-issues-tree";
import { Issue } from "../../../src/redmine/models/issue";

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 7392,
    subject: "Test Issue 1234",
    tracker: { id: 1, name: "Tasks" },
    status: { id: 1, name: "Not Yet Started" },
    author: { id: 1, name: "Viktor Rognås" },
    project: { id: 1, name: "Test Project" },
    priority: { id: 1, name: "Normal" },
    description: "",
    created_on: "2024-01-01",
    updated_on: "2024-01-01",
    ...overrides,
  };
}

describe("MyIssuesTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should format issue label with ID prefix", () => {
    const tree = new MyIssuesTree();
    const issue = createIssue({ description: "Test description" });

    const treeItem = tree.getTreeItem(issue);

    // Label includes issue ID for scannability (4.1 info density reduction)
    expect(treeItem.label).toBe("#7392 Test Issue 1234");
  });

  it("should format issue description as hours when no flexibility data", () => {
    const tree = new MyIssuesTree();
    const issue = createIssue();

    const treeItem = tree.getTreeItem(issue);

    // Shows hours even without flexibility (0:00/0:00 when no hours set)
    expect(treeItem.description).toBe("0:00/0:00");
  });

  it("should set command to open actions for issue", () => {
    const tree = new MyIssuesTree();
    const issue = createIssue({ description: "Test description" });

    const treeItem = tree.getTreeItem(issue);

    expect(treeItem.command?.command).toBe("redmyne.openActionsForIssue");
    expect(treeItem.command?.arguments?.[2]).toBe("7392");
  });

  it("returns empty top-level children without configured server", async () => {
    const tree = new MyIssuesTree();
    await expect(tree.getChildren()).resolves.toEqual([]);
  });

  it("builds parent containers and children from fetched issues", async () => {
    const root = createIssue({ id: 10, subject: "Root" });
    const child = createIssue({ id: 11, subject: "Child", parent: { id: 10 }, spent_hours: 2, estimated_hours: 5 });
    const orphanChild = createIssue({ id: 12, subject: "Orphan Child", parent: { id: 99 }, spent_hours: 1, estimated_hours: 3 });
    const missingParent = createIssue({ id: 99, subject: "Fetched Parent" });

    const server = {
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [root, child, orphanChild] }),
      getIssuesByIds: vi.fn().mockResolvedValue([missingParent]),
    };

    const tree = new MyIssuesTree();
    tree.setServer(server as never);

    const topLevel = await tree.getChildren();
    const container = topLevel.find((item) => isParentContainer(item)) as ParentContainer;

    expect(server.getIssuesAssignedToMe).toHaveBeenCalledTimes(1);
    expect(server.getIssuesByIds).toHaveBeenCalledWith([99]);
    expect(topLevel.some((item) => !isParentContainer(item) && (item as Issue).id === 10)).toBe(true);
    expect(container.id).toBe(99);
    expect(container.aggregatedHours).toEqual({ spent: 1, estimated: 3 });

    const containerChildren = await tree.getChildren(container);
    expect(containerChildren).toHaveLength(1);
    expect((containerChildren[0] as Issue).id).toBe(12);
  });

  it("shows orphan at root when missing-parent fetch fails", async () => {
    const orphanChild = createIssue({ id: 22, subject: "Orphan Child", parent: { id: 500 } });
    const server = {
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [orphanChild] }),
      getIssuesByIds: vi.fn().mockRejectedValue(new Error("forbidden")),
    };

    const tree = new MyIssuesTree();
    tree.setServer(server as never);

    const topLevel = await tree.getChildren();
    expect(topLevel).toHaveLength(1);
    expect((topLevel[0] as Issue).id).toBe(22);
  });

  it("deduplicates concurrent fetchIssuesIfNeeded requests", async () => {
    let resolveFetch: ((value: { issues: Issue[] }) => void) | undefined;
    const pending = new Promise<{ issues: Issue[] }>((resolve) => {
      resolveFetch = resolve;
    });

    const server = {
      getIssuesAssignedToMe: vi.fn().mockReturnValue(pending),
      getIssuesByIds: vi.fn().mockResolvedValue([]),
    };

    const tree = new MyIssuesTree();
    tree.setServer(server as never);

    const first = tree.fetchIssuesIfNeeded();
    const second = tree.fetchIssuesIfNeeded();

    resolveFetch?.({ issues: [createIssue({ id: 33 })] });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toHaveLength(1);
    expect(secondResult).toHaveLength(1);
    await expect(tree.fetchIssuesIfNeeded()).resolves.toHaveLength(1);
    expect(server.getIssuesAssignedToMe).toHaveBeenCalledTimes(1);
  });
});

describe("isParentContainer", () => {
  it("returns true for ParentContainer", () => {
    const container: ParentContainer = {
      id: 100,
      subject: "Parent Issue",
      isContainer: true,
      childCount: 3,
      aggregatedHours: { spent: 10, estimated: 40 },
    };

    expect(isParentContainer(container)).toBe(true);
  });

  it("returns false for Issue", () => {
    const issue = createIssue({ id: 7392, subject: "Test Issue" });

    expect(isParentContainer(issue)).toBe(false);
  });
});
