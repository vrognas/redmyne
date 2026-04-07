export class Membership {
  constructor(
    public readonly id: number,
    public readonly name: string,
    public readonly isUser = true,
    public readonly roles: string[] = []
  ) {}
}

export function groupMembersByRole(members: Membership[]): Map<string, string[]> {
  const byRole = new Map<string, string[]>();
  for (const m of members.filter((m) => m.isUser)) {
    for (const role of m.roles.length > 0 ? m.roles : ["Other"]) {
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role)!.push(m.name);
    }
  }
  return byRole;
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
