/**
 * Draft Operation Types and Interfaces
 * Core data structures for draft mode operations
 */

export type DraftOperationType =
  | "createIssue"
  | "updateIssue"
  | "deleteIssue"
  | "createTimeEntry"
  | "updateTimeEntry"
  | "deleteTimeEntry"
  | "createVersion"
  | "updateVersion"
  | "deleteVersion"
  | "createRelation"
  | "deleteRelation"
  | "setIssueStatus"
  | "setIssueDoneRatio"
  | "setIssuePriority"
  | "setIssueDates"
  | "setIssueAssignee"
  | "addIssueNote";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface DraftHttpPayload {
  method: HttpMethod;
  path: string;
  data?: Record<string, unknown>;
}

export interface DraftOperation {
  /** Unique identifier (UUID) */
  id: string;
  /** Type of operation */
  type: DraftOperationType;
  /** Timestamp when queued */
  timestamp: number;
  /** Issue ID if applicable */
  issueId?: number;
  /** Resource ID (time entry, version, relation) if applicable */
  resourceId?: number;
  /** Temp ID for create operations (draft-issue-xxx, draft-version-xxx) */
  tempId?: string;
  /** Human-readable description (e.g., "Set #123 status to In Progress") */
  description: string;
  /** HTTP payload for replay */
  http: DraftHttpPayload;
  /** Resource key for conflict detection (e.g., "issue:123:status") */
  resourceKey: string;
}

export interface DraftQueueState {
  version: 1;
  /** Hash of server URL + API key for identity validation */
  serverIdentity: string;
  operations: DraftOperation[];
}

/** Result of applying a draft operation */
export interface DraftApplyResult {
  operation: DraftOperation;
  success: boolean;
  error?: string;
  /** For create operations: the real ID assigned by server */
  realId?: number;
}

/** Mapping from temp IDs to real IDs after apply */
export type TempIdMap = Map<string, number>;

/** Generate a UUID for draft operations */
export function generateDraftId(): string {
  return crypto.randomUUID();
}

/** Generate a temp ID for create operations */
export function generateTempId(type: "issue" | "version" | "relation" | "timeentry"): string {
  return `draft-${type}-${crypto.randomUUID()}`;
}


/**
 * Generate a unique negative numeric temp ID for draft resources.
 * Uses UUID to ensure no collisions across sessions/reloads.
 * Returns negative number to distinguish from real Redmine IDs (always positive).
 */
export function generateNumericTempId(): number {
  // Use first 8 hex chars of UUID (32 bits) as base, negate to ensure negative
  const uuid = crypto.randomUUID();
  const hex = uuid.replace(/-/g, "").slice(0, 8);
  const num = parseInt(hex, 16);
  return -(num + 1); // +1 ensures we never return -0
}

/** Hash a string (for API key hashing) */
export async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}
