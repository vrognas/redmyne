export interface IssueLabelParts {
  id: number;
  subject: string;
}

export interface IssueLabelOptions {
  /** codicon id WITHOUT the $(...) wrapper, e.g. "archive". Rendered as "$(archive) " prefix. */
  icon?: string;
  /** separator between #id and subject. Defaults to a single space. */
  separator?: string;
}

/** Returns `$(icon) #id<sep>subject`. Caller is responsible for any HTML-escaping. */
export function formatIssueLabel(issue: IssueLabelParts, opts: IssueLabelOptions = {}): string {
  const sep = opts.separator ?? " ";
  const prefix = opts.icon ? `$(${opts.icon}) ` : "";
  return `${prefix}#${issue.id}${sep}${issue.subject}`;
}
