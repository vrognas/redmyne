export class Membership {
  constructor(
    public readonly id: number,
    public readonly name: string,
    public readonly isUser = true,
    public readonly roles: string[] = []
  ) {}
}

const ROLE_ORDER = ["Project Leader", "Analyst", "Peer Reviewer"];

export function groupMembersByRole(members: Membership[]): Map<string, string[]> {
  const byRole = new Map<string, string[]>();
  for (const m of members.filter((m) => m.isUser)) {
    for (const role of m.roles.length > 0 ? m.roles : ["Other"]) {
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role)!.push(m.name);
    }
  }
  // Sort: known roles first in defined order, then alphabetical
  const sorted = new Map<string, string[]>();
  for (const role of ROLE_ORDER) {
    if (byRole.has(role)) { sorted.set(role, byRole.get(role)!); byRole.delete(role); }
  }
  for (const [role, names] of [...byRole.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    sorted.set(role, names);
  }
  return sorted;
}

export class IssueStatus {
  constructor(
    public readonly statusId: number,
    public readonly name: string
  ) {}
}

export class QuickUpdate {
  constructor(
    public readonly issueId: number,
    public readonly message: string,
    public readonly assignee: Membership,
    public readonly status: IssueStatus,
    public readonly startDate?: string | null, // YYYY-MM-DD or null to clear
    public readonly dueDate?: string | null // YYYY-MM-DD or null to clear
  ) {}
}

export class QuickUpdateResult {
  public readonly differences: string[] = [];

  public isSuccessful() {
    return this.differences.length === 0;
  }

  public addDifference(difference: string) {
    this.differences.push(difference);
  }
}
