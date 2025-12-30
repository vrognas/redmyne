import { TimeEntry } from "../redmine/models/time-entry";
import { adHocTracker } from "./adhoc-tracker";

/**
 * Pattern to extract issue ID from time entry comments
 * Matches first occurrence of #<number>
 */
const ISSUE_REF_PATTERN = /#(\d+)/;

/**
 * Parse target issue ID from time entry comment
 * Returns first #<number> found, or null if none
 */
export function parseTargetIssueId(comment: string): number | null {
  if (!comment) return null;
  const match = comment.match(ISSUE_REF_PATTERN);
  return match ? parseInt(match[1], 10) : null;
}

export interface ContributionSource {
  fromIssueId: number;
  hours: number;
}

export interface DonationTarget {
  toIssueId: number;
  hours: number;
}

export interface ContributionResult {
  /** Total hours contributed TO each target issue */
  contributedTo: Map<number, number>;
  /** Total hours donated FROM each ad-hoc issue */
  donatedFrom: Map<number, number>;
  /** Detailed breakdown: target issue -> sources */
  contributionSources: Map<number, ContributionSource[]>;
  /** Detailed breakdown: ad-hoc issue -> targets */
  donationTargets: Map<number, DonationTarget[]>;
}

/**
 * Calculate hour contributions from ad-hoc issues to target issues
 * based on time entry comments containing #<issueId>
 */
export function calculateContributions(entries: TimeEntry[]): ContributionResult {
  const contributedTo = new Map<number, number>();
  const donatedFrom = new Map<number, number>();
  const contributionSources = new Map<number, ContributionSource[]>();
  const donationTargets = new Map<number, DonationTarget[]>();

  for (const entry of entries) {
    const sourceIssueId = entry.issue?.id ?? entry.issue_id;

    // Only process entries on ad-hoc issues
    if (!adHocTracker.isAdHoc(sourceIssueId)) continue;

    // Parse target issue from comment
    const targetIssueId = parseTargetIssueId(entry.comments);
    if (!targetIssueId) continue;

    const hours = parseFloat(entry.hours);

    // Update total contributed to target
    contributedTo.set(
      targetIssueId,
      (contributedTo.get(targetIssueId) ?? 0) + hours
    );

    // Update total donated from source
    donatedFrom.set(
      sourceIssueId,
      (donatedFrom.get(sourceIssueId) ?? 0) + hours
    );

    // Track detailed sources for target
    if (!contributionSources.has(targetIssueId)) {
      contributionSources.set(targetIssueId, []);
    }
    const sources = contributionSources.get(targetIssueId)!;
    const existingSource = sources.find(s => s.fromIssueId === sourceIssueId);
    if (existingSource) {
      existingSource.hours += hours;
    } else {
      sources.push({ fromIssueId: sourceIssueId, hours });
    }

    // Track detailed targets for source
    if (!donationTargets.has(sourceIssueId)) {
      donationTargets.set(sourceIssueId, []);
    }
    const targets = donationTargets.get(sourceIssueId)!;
    const existingTarget = targets.find(t => t.toIssueId === targetIssueId);
    if (existingTarget) {
      existingTarget.hours += hours;
    } else {
      targets.push({ toIssueId: targetIssueId, hours });
    }
  }

  return { contributedTo, donatedFrom, contributionSources, donationTargets };
}

/**
 * Get effective spent hours for an issue accounting for contributions
 * - Normal issue: spentHours + contributedHours
 * - Ad-hoc issue: -donatedHours (negative = budget depleted)
 */
export function getEffectiveSpentHours(
  issueId: number,
  spentHours: number,
  contributions: ContributionResult
): number {
  if (adHocTracker.isAdHoc(issueId)) {
    // Ad-hoc: show negative (depleted budget)
    const donated = contributions.donatedFrom.get(issueId) ?? 0;
    return -donated;
  } else {
    // Normal: add any contributed hours
    const contributed = contributions.contributedTo.get(issueId) ?? 0;
    return spentHours + contributed;
  }
}
