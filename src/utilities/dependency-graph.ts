import type { Issue } from "../redmine/models/issue";

/**
 * Dependency graph node with upstream (blockers) and downstream (dependents)
 */
export interface DependencyNode {
  upstream: Set<number>; // Issues that block this one
  downstream: Set<number>; // Issues blocked by this one
}

export type DependencyGraph = Map<number, DependencyNode>;

let downstreamCountCache = new WeakMap<DependencyGraph, Map<number, number>>();

/**
 * Blocker info for display
 */
export interface BlockerInfo {
  id: number;
  subject: string;
  assignee: string | null;
  status: string;
  /** True if issue not in visible issueMap (e.g., filtered out, different assignee) */
  isHidden?: boolean;
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
  // Redmine API returns relations from BOTH perspectives - need to handle correctly
  for (const issue of issues) {
    if (!issue.relations) continue;

    for (const rel of issue.relations) {
      // rel.issue_id is the "owner" of the relation, rel.issue_to_id is the target
      // relation_type describes: issue_id <relation_type> issue_to_id
      // e.g., "blocks" means issue_id blocks issue_to_id

      // Only process relations where current issue is the owner (issue_id)
      // This ensures each relation is processed exactly once
      if (rel.issue_id !== issue.id) continue;

      const fromId = rel.issue_id;
      const toId = rel.issue_to_id;

      // Skip self-references (malformed data)
      if (toId === fromId) continue;

      // Ensure target node exists (may be external)
      if (!graph.has(toId)) {
        graph.set(toId, { upstream: new Set(), downstream: new Set() });
      }

      if (BLOCKING_RELATIONS.has(rel.relation_type)) {
        // fromId blocks toId → toId is downstream of fromId
        graph.get(fromId)!.downstream.add(toId);
        graph.get(toId)!.upstream.add(fromId);
      } else if (BLOCKED_RELATIONS.has(rel.relation_type)) {
        // fromId is blocked by toId → fromId is downstream of toId
        graph.get(toId)!.downstream.add(fromId);
        graph.get(fromId)!.upstream.add(toId);
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
function computeDownstreamCount(issueId: number, graph: DependencyGraph): number {
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

export function countDownstream(issueId: number, graph: DependencyGraph): number {
  let cache = downstreamCountCache.get(graph);
  if (!cache) {
    cache = new Map();
    downstreamCountCache.set(graph, cache);
  }

  const cached = cache.get(issueId);
  if (cached !== undefined) return cached;

  const count = computeDownstreamCount(issueId, graph);
  cache.set(issueId, count);
  return count;
}

export function resetDownstreamCountCache(graph?: DependencyGraph): void {
  if (graph) {
    downstreamCountCache.delete(graph);
    return;
  }
  downstreamCountCache = new WeakMap();
}

/**
 * Get downstream issues blocked by this one (direct only, open only)
 * Returns partial info for issues not in issueMap (hidden/filtered)
 */
export function getDownstream(
  issueId: number,
  graph: DependencyGraph,
  issueMap: Map<number, Issue>
): BlockerInfo[] {
  const node = graph.get(issueId);
  if (!node) return [];

  const downstream: BlockerInfo[] = [];

  for (const blockedId of node.downstream) {
    const blocked = issueMap.get(blockedId);

    if (!blocked) {
      // Issue exists in graph but not in visible issueMap (filtered out)
      downstream.push({
        id: blockedId,
        subject: `#${blockedId}`,
        assignee: null,
        status: "Unknown",
        isHidden: true,
      });
      continue;
    }

    // Skip closed issues
    if (blocked.closed_on !== null) continue;

    downstream.push({
      id: blocked.id,
      subject: blocked.subject,
      assignee: blocked.assigned_to?.name ?? null,
      status: blocked.status?.name ?? "Unknown",
    });
  }

  return downstream;
}

/**
 * Get blocker details for an issue (direct upstream, open only)
 * Returns partial info for issues not in issueMap (hidden/filtered)
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

    if (!blocker) {
      // Issue exists in graph but not in visible issueMap (filtered out)
      blockers.push({
        id: blockerId,
        subject: `#${blockerId}`,
        assignee: null,
        status: "Unknown",
        isHidden: true,
      });
      continue;
    }

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
