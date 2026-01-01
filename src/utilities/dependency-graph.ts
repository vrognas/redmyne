import type { Issue } from "../redmine/models/issue";

/**
 * Dependency graph node with upstream (blockers) and downstream (dependents)
 */
export interface DependencyNode {
  upstream: Set<number>; // Issues that block this one
  downstream: Set<number>; // Issues blocked by this one
}

export type DependencyGraph = Map<number, DependencyNode>;

/**
 * Blocker info for display
 */
export interface BlockerInfo {
  id: number;
  subject: string;
  assignee: string | null;
  status: string;
}

// Relation types that indicate "source must complete before target"
const BLOCKING_RELATIONS = new Set(["blocks", "precedes"]);
// Relation types that indicate "source waits for target"
const BLOCKED_RELATIONS = new Set(["blocked", "follows"]);

/**
 * Build dependency graph from issues with relations
 * Tracks both directions: who blocks whom and who is blocked by whom
 */
export function buildDependencyGraph(issues: Issue[]): DependencyGraph {
  const graph: DependencyGraph = new Map();

  // Initialize nodes for all issues
  for (const issue of issues) {
    graph.set(issue.id, { upstream: new Set(), downstream: new Set() });
  }

  // Process relations
  for (const issue of issues) {
    if (!issue.relations) continue;

    for (const rel of issue.relations) {
      const sourceId = issue.id;
      const targetId = rel.issue_to_id;

      // Ensure target node exists (may be external)
      if (!graph.has(targetId)) {
        graph.set(targetId, { upstream: new Set(), downstream: new Set() });
      }

      if (BLOCKING_RELATIONS.has(rel.relation_type)) {
        // source blocks target → target is downstream of source
        graph.get(sourceId)!.downstream.add(targetId);
        graph.get(targetId)!.upstream.add(sourceId);
      } else if (BLOCKED_RELATIONS.has(rel.relation_type)) {
        // source is blocked by target → source is downstream of target
        graph.get(targetId)!.downstream.add(sourceId);
        graph.get(sourceId)!.upstream.add(targetId);
      }
      // Ignore non-dependency relations (relates, duplicates, etc.)
    }
  }

  return graph;
}

/**
 * Count all downstream issues (transitive closure)
 * Returns how many issues depend on this one directly or indirectly
 */
export function countDownstream(issueId: number, graph: DependencyGraph): number {
  const node = graph.get(issueId);
  if (!node) return 0;

  const visited = new Set<number>();
  const queue = [...node.downstream];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const downstream = graph.get(id)?.downstream;
    if (downstream) {
      for (const childId of downstream) {
        if (!visited.has(childId)) {
          queue.push(childId);
        }
      }
    }
  }

  return visited.size;
}

/**
 * Get blocker details for an issue (direct upstream, open only)
 */
export function getBlockers(
  issueId: number,
  graph: DependencyGraph,
  issueMap: Map<number, Issue>
): BlockerInfo[] {
  const node = graph.get(issueId);
  if (!node) return [];

  const blockers: BlockerInfo[] = [];

  for (const blockerId of node.upstream) {
    const blocker = issueMap.get(blockerId);
    if (!blocker) continue;

    // Skip closed blockers
    if (blocker.closed_on !== null) continue;

    blockers.push({
      id: blocker.id,
      subject: blocker.subject,
      assignee: blocker.assigned_to?.name ?? null,
      status: blocker.status?.name ?? "Unknown",
    });
  }

  return blockers;
}
